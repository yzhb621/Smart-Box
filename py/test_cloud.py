import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from cloud import CloudClient, StateStore


class CloudTests(unittest.TestCase):
    def test_state_survives_restart_and_clear(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            StateStore(path).save({'phase': 'opened', 'parcelId': 'example'})
            self.assertEqual(StateStore(path).load()['phase'], 'opened')
            StateStore(path).clear()
            self.assertIsNone(StateStore(path).load())

    def test_requires_secure_origin(self):
        with self.assertRaises(ValueError):
            CloudClient('http://example.com')
        CloudClient('http://localhost:8080')

    def test_authenticated_request_reads_current_token(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'token'
            path.write_text('existing-token')
            with patch('cloud.urlopen') as open_request:
                open_request.return_value.__enter__.return_value.read.return_value = b'{"success":true}'
                self.assertTrue(CloudClient('https://example.com', path).post('/api/pickups/verify', {'deliveryId': 'example'})['success'])
                request = open_request.call_args.args[0]
                self.assertEqual(request.get_header('Authorization'), 'Bearer existing-token')
                self.assertEqual(json.loads(request.data), {'deliveryId': 'example'})


if __name__ == '__main__':
    unittest.main()
