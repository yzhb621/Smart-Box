"""Exercise controller ordering and recovery without real GPIO/camera access."""
import base64
import importlib
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

with patch.dict(sys.modules, {name: MagicMock() for name in (
        'cv2', 'PIL', 'PIL.Image', 'PIL.ImageDraw', 'qrcode', 'pyzbar', 'gpiozero',
        'luma', 'luma.core', 'luma.core.interface', 'luma.core.interface.serial',
        'luma.oled', 'luma.oled.device', 'luma.core.render')}):
    controller = importlib.import_module('app')


class ControllerTests(unittest.TestCase):
    def make_controller(self):
        app = controller.SmartCourierBoxApp.__new__(controller.SmartCourierBoxApp)
        app.generated_code = '123456'
        app.code_expires_at = time.monotonic() + 60
        app.delivery_state = {'phase': 'delivered', 'deliveryId': 'example', 'code': '123456'}
        app.camera = MagicMock()
        app.camera.scan_for_qr.return_value = base64.b64encode(b'123456').decode()
        app.actuator = MagicMock()
        app.store = MagicMock()
        app.cloud = MagicMock()
        app.cloud.post.return_value = {'id': 'parcel-id'}
        app.update_state = MagicMock()
        app._show_message = MagicMock()
        return app

    def test_verify_precedes_open_and_completion_follows_open(self):
        app = self.make_controller()
        events = []
        app.cloud.post.side_effect = lambda path, body: events.append(path) or {'id': 'parcel-id'}
        app.actuator.open.side_effect = lambda: events.append('open')
        app._scan_pickup_flow()
        self.assertEqual(events, ['/api/pickups/verify', 'open', '/api/parcels/parcel-id/retrieve'])
        app.store.clear.assert_called_once()

    def test_cloud_verification_failure_does_not_open_box(self):
        app = self.make_controller()
        app.cloud.post.side_effect = RuntimeError('offline')
        app._scan_pickup_flow()
        app.actuator.open.assert_not_called()
        self.assertEqual(app.delivery_state['phase'], 'delivered')

    def test_failed_completion_keeps_durable_state_and_retry_does_not_reopen(self):
        app = self.make_controller()
        app.cloud.post.side_effect = [{'id': 'parcel-id'}, RuntimeError('offline')]
        app._scan_pickup_flow()
        self.assertEqual(app.delivery_state['phase'], 'opened')
        app.store.clear.assert_not_called()
        app.cloud.post.side_effect = None
        app._sync_pickup()
        app.actuator.open.assert_called_once()
        app.store.clear.assert_called_once()

    def test_actuator_failure_requires_physical_inspection_before_retry(self):
        app = self.make_controller()
        app.actuator.open.side_effect = RuntimeError('driver error')
        app._scan_pickup_flow()
        self.assertEqual(app.delivery_state['phase'], 'opening')
        app.on_button()
        app.actuator.open.assert_called_once()
        self.assertEqual(app.cloud.post.call_count, 1)


if __name__ == '__main__':
    unittest.main()
