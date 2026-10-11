#!/usr/bin/env python3
"""
Physical Smart Courier Box controller for Raspberry Pi

Mirrors the behavior of sim/public/sim.js:
- WAITING/READY: wait for start button press
- SCANNING_EMAIL: use camera to scan a recipient-email QR (base64-encoded email)
- CODE_GENERATED: generate a 6-digit pickup code, display QR on OLED, activate actuator to lock
- SCANNING_PICKUP_CODE: scan pickup QR (base64-encoded 6-digit code)
- OPENED: activate actuator to open, show success, then reset

Assumptions (reasonable defaults):
- One physical button wired to a GPIO pin to advance modes
- One GPIO pin drives the linear actuator via a relay/driver (simple pulse to toggle)
- Camera available via OpenCV (VideoCapture(0))
- OLED available via either luma.oled or Adafruit libraries; code falls back to saving the QR to disk

Configure pins and timing below.

Requirements: see `py/setup/requirements.txt` for the Python packages recommended for full functionality.

Run on the Pi: python3 py/app.py
"""

import base64
import os
import secrets
from urllib.parse import urlencode
import io
import logging
import signal
import sys
import threading
import time
from enum import Enum

try:
    import cv2
except Exception as e:
    print("Missing OpenCV (cv2). Install opencv-python")
    raise

from PIL import Image, ImageDraw

try:
    import qrcode
except Exception:
    print("Missing qrcode package. Install qrcode[pil]")
    raise

try:
    from pyzbar import pyzbar
except Exception:
    print("Missing pyzbar. Install pyzbar")
    raise

# GPIO libraries: try gpiozero (friendly), fallback to RPi.GPIO
GPIO_AVAILABLE = False
try:
    from gpiozero import Button, OutputDevice
    GPIO_AVAILABLE = True
except Exception:
    try:
        import RPi.GPIO as GPIO
        GPIO_AVAILABLE = True
    except Exception:
        GPIO_AVAILABLE = False

# OLED display support: try luma.oled first, then Adafruit SSD1306
OLED_DRIVER = None
try:
    from luma.core.interface.serial import i2c
    from luma.oled.device import ssd1306
    from luma.core.render import canvas
    OLED_DRIVER = 'luma'
except Exception:
    try:
        import board
        import busio
        from digitalio import DigitalInOut
        import adafruit_ssd1306
        OLED_DRIVER = 'adafruit'
    except Exception:
        OLED_DRIVER = None

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('scb')


class SystemState(Enum):
    READY = 'ready'
    SCANNING_EMAIL = 'scanning_email'
    CODE_GENERATED = 'code_generated'
    SCANNING_PICKUP_CODE = 'scanning_pickup_code'
    OPENED = 'opened'


# ====== Configuration - adjust pins and durations for your hardware ======
BUTTON_PIN = 17              # GPIO pin for the physical button (BCM numbering)
ACTUATOR_PIN = 27            # If single-pin: relay trigger; if H-bridge: EN/PWM pin
ACTUATOR_PULSE_SEC = 0.6     # how long to drive actuator to toggle (open/close)

# H-bridge mode (e.g., DRV8231A): set to 'hbridge' and assign a DIR pin.
# Add 'solenoid' for one-pin spring-return lock: open() pulses, close() no-op.
ACTUATOR_MODE = 'solenoid'   # 'single', 'hbridge', or 'solenoid'
ACTUATOR_DIR_PIN = 22        # used only for 'hbridge'
ACTUATOR_OPEN_SEC = 4.0
ACTUATOR_CLOSE_SEC = 4.0     # run time to fully close

SCAN_TIMEOUT = 30            # seconds to wait while scanning
OLED_I2C_ADDR = 0x3C         # common SSD1306 I2C address
CODE_LIFETIME_SEC = 600
BASE_URL = os.environ.get('SCB_BASE_URL', 'http://localhost:8080').rstrip('/')
AREA_ID = os.environ.get("SCB_POST_CODE", "0000")
SER_ID = os.environ.get("SCB_SERIAL", "4")
# =======================================================================


class PhysicalActuator:
    def __init__(self, pin=ACTUATOR_PIN, dir_pin=None, mode: str = ACTUATOR_MODE):
        self.pin = pin
        self.dir_pin = dir_pin
        self.mode = mode if (mode in ('single', 'hbridge', 'solenoid') and (mode != 'hbridge' or dir_pin is not None)) else 'single'
        self._using_gpiozero = False
        self.dev = None
        self.dir_dev = None

        if not GPIO_AVAILABLE:
            return

        try:
            from gpiozero import OutputDevice
            if self.mode == 'single':
                self.dev = OutputDevice(pin)
            else:
                self.en_dev = OutputDevice(pin)   # EN/PWM (we drive full speed)
                self.dir_dev = OutputDevice(dir_pin)
            self._using_gpiozero = True
        except Exception:
            try:
                import RPi.GPIO as GPIO
                self.GPIO = GPIO
                GPIO.setmode(GPIO.BCM)
                if self.mode == 'single':
                    GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)
                else:
                    GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)       # EN
                    GPIO.setup(dir_pin, GPIO.OUT, initial=GPIO.LOW)   # DIR
            except Exception:
                log.warning('GPIO available but failed to initialize actuator')

    def pulse(self, duration=ACTUATOR_PULSE_SEC):
        log.info('Actuator pulse %ss', duration)
        if not GPIO_AVAILABLE:
            log.warning('GPIO not available; skipping actuator pulse')
            return
        if self.mode != 'single':
            # Fallback behavior if called in hbridge mode: brief enable with current DIR
            self._drive_enabled(duration=duration)
            return
        try:
            if self._using_gpiozero:
                self.dev.on()
                time.sleep(duration)
                self.dev.off()
            else:
                self.GPIO.output(self.pin, self.GPIO.HIGH)
                time.sleep(duration)
                self.GPIO.output(self.pin, self.GPIO.LOW)
        except Exception as e:
            log.exception('Failed to pulse actuator: %s', e)

    def open(self, duration=ACTUATOR_OPEN_SEC):
        if self.mode == 'hbridge':
            self._drive_dir(dir_high=True, duration=duration)
            return
        if self.mode == 'solenoid':
            # Energize coil briefly to unlatch/open
            self.pulse(duration=max(0.2, ACTUATOR_PULSE_SEC))
            return
        # 'single' legacy: pulse a toggling driver
        self.pulse(duration=ACTUATOR_PULSE_SEC)

    def close(self, duration=ACTUATOR_CLOSE_SEC):
        if self.mode == 'hbridge':
            self._drive_dir(dir_high=False, duration=duration)
            return
        if self.mode == 'solenoid':
            # Spring returns; locked when unpowered
            log.info('Solenoid close: no-op (locked unpowered)')
            return
        # 'single' legacy: pulse a toggling driver
        self.pulse(duration=ACTUATOR_PULSE_SEC)

    # --- helpers for hbridge ---
    def _drive_dir(self, dir_high: bool, duration: float):
        if not GPIO_AVAILABLE:
            log.warning('GPIO not available; skipping drive')
            return
        try:
            if self._using_gpiozero:
                if dir_high:
                    self.dir_dev.on()
                else:
                    self.dir_dev.off()
                self.en_dev.on()
                time.sleep(duration)
                self.en_dev.off()
            else:
                self.GPIO.output(self.dir_pin, self.GPIO.HIGH if dir_high else self.GPIO.LOW)
                self.GPIO.output(self.pin, self.GPIO.HIGH)  # EN on
                time.sleep(duration)
                self.GPIO.output(self.pin, self.GPIO.LOW)   # EN off
        except Exception as e:
            log.exception('Failed to drive actuator: %s', e)

    def _drive_enabled(self, duration: float):
        # Enable output for a duration using current DIR state
        try:
            if self._using_gpiozero:
                self.en_dev.on()
                time.sleep(duration)
                self.en_dev.off()
            else:
                self.GPIO.output(self.pin, self.GPIO.HIGH)
                time.sleep(duration)
                self.GPIO.output(self.pin, self.GPIO.LOW)
        except Exception as e:
            log.exception('Failed to enable actuator: %s', e)


class PhysicalButton:
    def __init__(self, pin=BUTTON_PIN, callback=None):
        self.pin = pin
        self.callback = callback
        self._using_gpiozero = False
        if GPIO_AVAILABLE:
            try:
                from gpiozero import Button as GZButton
                self.btn = GZButton(pin, pull_up=True)
                self.btn.when_pressed = self._on_press
                self._using_gpiozero = True
            except Exception:
                try:
                    import RPi.GPIO as GPIO
                    self.GPIO = GPIO
                    GPIO.setmode(GPIO.BCM)
                    GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
                    GPIO.add_event_detect(pin, GPIO.FALLING, callback=self._on_press, bouncetime=200)
                except Exception:
                    log.warning('GPIO available but failed to initialize button')
                    self.btn = None
        else:
            self.btn = None

    def _on_press(self, *args):
        log.info('Button pressed')
        if self.callback:
            try:
                self.callback()
            except Exception:
                log.exception('Button callback failed')


class OLEDDisplay:
    def __init__(self):
        self.driver = OLED_DRIVER
        self.device = None
        if self.driver == 'luma':
            try:
                serial = i2c(port=1, address=OLED_I2C_ADDR)
                self.device = ssd1306(serial)
            except Exception:
                log.exception('Failed to init luma OLED')
                self.device = None
        elif self.driver == 'adafruit':
            try:
                i2c_bus = busio.I2C(board.SCL, board.SDA)
                self.device = adafruit_ssd1306.SSD1306_I2C(128, 64, i2c_bus, addr=OLED_I2C_ADDR)
            except Exception:
                log.exception('Failed to init adafruit OLED')
                self.device = None
        else:
            log.warning('No OLED driver available; will save QR to disk instead')

    def show_image(self, pil_img: Image.Image):
        """Draw a PIL image (mode '1' or 'RGB') to the OLED.
        Falls back to saving to /tmp/pickup_qr.png if no OLED driver present.
        """
        if self.device is None:
            path = '/tmp/pickup_qr.png'
            pil_img.save(path)
            log.info('Saved QR to %s (OLED not available)', path)
            return

        img = pil_img.convert('1')
        try:
            if self.driver == 'luma':
                with canvas(self.device) as draw:
                    self.device.display(img)
            elif self.driver == 'adafruit':
                # adafruit expects a 1-bit bytearray or Image
                self.device.image(img)
                self.device.show()
        except Exception:
            log.exception('Failed to draw to OLED; saving image instead')
            path = '/tmp/pickup_qr.png'
            pil_img.save(path)
            log.info('Saved QR to %s', path)


class CameraScanner:
    def __init__(self, camera_idx=0):
        self.cap = cv2.VideoCapture(camera_idx)
        if not self.cap.isOpened():
            raise RuntimeError('Failed to open camera index %s' % camera_idx)

    def read_frame(self):
        ret, frame = self.cap.read()
        if not ret:
            raise RuntimeError('Failed to grab frame from camera')
        return frame

    def scan_for_qr(self, timeout=SCAN_TIMEOUT):
        """Scan frames until a QR code is found or timeout (seconds).
        Returns the decoded text or None on timeout.
        """
        log.info('Starting camera scan for up to %ss', timeout)
        deadline = time.time() + timeout
        while time.time() < deadline:
            frame = self.read_frame()
            decoded = pyzbar.decode(frame)
            if decoded:
                text = decoded[0].data.decode('utf-8')
                log.info('QR decoded: %s', text)
                return text
            # small sleep to yield
            time.sleep(0.05)
        log.info('Camera scan timed out')
        return None

    def release(self):
        try:
            self.cap.release()
        except Exception:
            pass


class SmartCourierBoxApp:
    def __init__(self):
        self.state = SystemState.READY
        self.generated_code = None
        self.camera = CameraScanner()
        # Initialize actuator for current mode
        dir_pin = ACTUATOR_DIR_PIN if ACTUATOR_MODE == 'hbridge' else None
        self.actuator = PhysicalActuator(pin=ACTUATOR_PIN, dir_pin=dir_pin, mode=ACTUATOR_MODE)
        self.oled = OLEDDisplay()
        self.button = PhysicalButton(callback=self.on_button)
        self.lock = threading.Lock()
        self._stop = False

    def update_state(self, new_state: SystemState):
        with self.lock:
            self.state = new_state
            log.info('State -> %s', new_state.value)
            if new_state == SystemState.READY:
                self._show_message('System Ready', 'Press button to start')
            elif new_state == SystemState.SCANNING_EMAIL:
                self._show_message('Scan recipient email', 'Point camera at email QR')
            elif new_state == SystemState.CODE_GENERATED:
                self._show_message('Pickup code generated', 'Await pickup scan')
            elif new_state == SystemState.SCANNING_PICKUP_CODE:
                self._show_message('Scan pickup code', 'Point camera at pickup QR')
            elif new_state == SystemState.OPENED:
                self._show_message('Verified! Box Opened', 'Pickup completed')

    def _show_message(self, line1, line2=''):
        # Render a simple two-line message to OLED (or console/file)
        img = Image.new('RGB', (128, 64), color='black')
        draw = ImageDraw.Draw(img)
        draw.text((0, 0), line1, fill='white')
        draw.text((0, 20), line2, fill='white')
        self.oled.show_image(img)

    def generate_pickup_code(self):
        self.generated_code = str(100000 + secrets.randbelow(900000))
        self.code_expires_at = time.monotonic() + CODE_LIFETIME_SEC
        return self.generated_code

    def show_pickup_qr(self):
        # Build the full URL payload to match simulator:
        # https://smart-courier-box.vercel.app/p?e=<email_b64>&c=<code_b64>&a=<area_b64>&s=<ser_b64>
        # Use the originally scanned base64 email (self.scanned_email_b64) when available.
        email_b64 = getattr(self, 'scanned_email_b64', None)
        if email_b64 is None:
            # fallback: base64-encode an empty email
            email_b64 = base64.b64encode(b'').decode('utf-8')
        code_b64 = base64.b64encode(self.generated_code.encode('utf-8')).decode('utf-8')
        area_b64 = base64.b64encode(AREA_ID.encode('utf-8')).decode('utf-8')
        ser_b64 = base64.b64encode(str(SER_ID).encode('utf-8')).decode('utf-8')
        payload_url = (
            BASE_URL + "/p?" + urlencode({"e": email_b64, "c": code_b64, "a": area_b64, "s": ser_b64})
        )
        # create a QR image sized for OLED
        qr = qrcode.QRCode(box_size=2, border=1)
        qr.add_data(payload_url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white").convert('RGB')
        # center QR on 128x64 canvas
        canvas_img = Image.new('RGB', (128, 64), 'white')
        w, h = img.size
        x = max(0, (128 - w) // 2)
        y = max(0, (64 - h) // 2)
        canvas_img.paste(img, (x, y))
        self.oled.show_image(canvas_img)

    def on_button(self):
        # Button press advances actions depending on state
        with self.lock:
            st = self.state
        if st == SystemState.READY:
            # start scanning for recipient email
            threading.Thread(target=self._scan_email_flow, daemon=True).start()
        elif st == SystemState.CODE_GENERATED:
            threading.Thread(target=self._scan_pickup_flow, daemon=True).start()
        else:
            log.info('Button press ignored in state %s', st.value)

    def _scan_email_flow(self):
        self.update_state(SystemState.SCANNING_EMAIL)
        decoded = self.camera.scan_for_qr()
        if decoded is None:
            self._show_message('Scan timed out', 'Returning to ready')
            time.sleep(2)
            self.update_state(SystemState.READY)
            return

        # Email is expected to be base64-encoded in the QR
        try:
            # decoded is expected to be the base64 string representing the email
            email = base64.b64decode(decoded).decode('utf-8')
            # simple validation
            if '@' not in email or '.' not in email:
                raise ValueError('invalid email')
            # store both the decoded email and the original base64 token
            self.recipient_email = email
            self.scanned_email_b64 = decoded
        except Exception:
            log.info('Invalid email QR: %s', decoded)
            self._show_message('Invalid email QR', '')
            time.sleep(2)
            self.update_state(SystemState.READY)
            return

        # valid email -> generate pickup code and display QR
        self.generate_pickup_code()
        self.show_pickup_qr()
        # lock box using actuator (drive to "closed" end)
        self.actuator.close()
        self.update_state(SystemState.CODE_GENERATED)

    def _scan_pickup_flow(self):
        self.update_state(SystemState.SCANNING_PICKUP_CODE)
        decoded = self.camera.scan_for_qr()
        if decoded is None:
            self._show_message('Scan timed out', 'Returning to ready')
            time.sleep(2)
            self.update_state(SystemState.READY)
            return

        try:
            decoded_plain = base64.b64decode(decoded).decode('utf-8')
        except Exception:
            decoded_plain = decoded

        log.info('Pickup scan content -> %s', decoded_plain)
        if self.generated_code and decoded_plain == self.generated_code and time.monotonic() < self.code_expires_at:
            # success: open box (drive to "open" end)
            self.camera.release()
            self.actuator.open()
            self.update_state(SystemState.OPENED)
            time.sleep(3)
            self.generated_code = None
            self.update_state(SystemState.READY)
            # reopen camera for future scans
            self.camera = CameraScanner()
        else:
            self._show_message('Invalid pickup code', '')
            time.sleep(2)
            self.update_state(SystemState.CODE_GENERATED)

    def run(self):
        self.update_state(SystemState.READY)
        # main loop - keep alive
        try:
            while not self._stop:
                time.sleep(0.5)
        except KeyboardInterrupt:
            log.info('Interrupted')
        finally:
            self.cleanup()

    def stop(self):
        self._stop = True

    def cleanup(self):
        log.info('Cleaning up')
        try:
            self.camera.release()
        except Exception:
            pass
        # if using RPi.GPIO, call cleanup
        try:
            import RPi.GPIO as GPIO
            GPIO.cleanup()
        except Exception:
            pass


def main():
    app = SmartCourierBoxApp()

    def _signal_handler(sig, frame):
        log.info('Signal %s received, exiting', sig)
        app.stop()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)
    app.run()


if __name__ == '__main__':
    main()
