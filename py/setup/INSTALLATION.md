Smart Courier Box — Raspberry Pi installation guide
========================================

This guide complements `py/setup_pi.sh`. Follow these steps on your Raspberry Pi 3B+ to prepare the system and run the physical controller in `py/app.py`.

Prerequisites
-------------
- Raspberry Pi OS (Bullseye or later recommended)
- Network access to install packages
- Hardware: Pi Camera (or USB camera), SSD1306 I2C OLED (optional), relay/driver for linear actuator, push button

Quick setup (automated)
-----------------------
1. Place this project on the Pi and cd into the repository root.
2. Run the setup script from the repo root (it will create a venv inside `py/`):

   sudo bash py/setup_pi.sh

3. Reboot if the script recommends it.
4. After reboot, activate the venv and run the app:

   cd py
   source venv/bin/activate
   python3 app.py

Manual steps and explanation
----------------------------
1) System packages (apt)

   The app uses OpenCV, zbar (for decoding QR codes), and Pillow. Install required system libraries first (example):

   sudo apt update
   sudo apt install -y build-essential cmake pkg-config \
     libjpeg-dev libpng-dev libtiff5-dev \
     libavcodec-dev libavformat-dev libswscale-dev \
     libv4l-dev libxvidcore-dev libx264-dev \
     libgtk2.0-dev libatlas-base-dev gfortran \
     python3-dev python3-venv libopenjp2-7 libopenjp2-7-dev \
     libzbar0 libzbar-dev i2c-tools

2) Enable I2C and Camera

   Use raspi-config to enable interfaces:

   sudo raspi-config
   -> Interface Options -> I2C -> Enable
   -> Interface Options -> Camera -> Enable

   Or (non-interactive) run:

   sudo raspi-config nonint do_i2c 0
   sudo raspi-config nonint do_camera 0

3) Create Python venv and install Python packages

   cd py
   python3 -m venv venv
   source venv/bin/activate
   python -m pip install --upgrade pip setuptools wheel
   pip install -r requirements.txt

   If pip install fails for OpenCV on the Pi, try `opencv-python-headless` or install OpenCV via apt or build from source.

4) Add user to groups (permission convenience)

   sudo usermod -aG gpio $USER
   sudo usermod -aG video $USER

   Then logout/login (or reboot) to apply group membership.

Hardware wiring
----------------
- Button: connect one side to the configured GPIO pin (default BCM 17) and the other to GND. The code enables an internal pull-up.
- Actuator: use a relay or motor driver. Control input connects to ACTUATOR_PIN (default BCM 27). Do NOT drive the actuator directly from a GPIO pin.
- OLED (SSD1306): connect SDA->SDA (BCM 2), SCL->SCL (BCM 3), VCC->3.3V, GND->GND. Enable I2C first.
- Camera: enable camera in raspi-config and run a camera test (libcamera-hello or raspivid depending on your stack).

Notes & troubleshooting
-----------------------
- OpenCV VideoCapture issues: On modern Raspberry Pi OS, the libcamera stack is used. OpenCV's VideoCapture(0) may not work out-of-the-box with libcamera. If you see camera errors, either enable legacy v4l (not recommended) or adapt the code to use libcamera bindings. Tell me if you'd like a libcamera fallback.

- OLED not detected: ensure I2C is enabled and `i2cdetect -y 1` shows the device (usually 0x3C). If luma or Adafruit drivers are not installed the app will save the QR to `/tmp/pickup_qr.png`.

- Permission errors for GPIO: run with sudo or add your user to the `gpio` group as described above.

- pyzbar errors: make sure `libzbar0` and `libzbar-dev` are installed via apt before `pip install pyzbar`.

Advanced
--------
- To use system-installed gpiozero and RPi.GPIO packages (recommended), install via apt:

  sudo apt install -y python3-gpiozero python3-rpi.gpio

- If you prefer not to use a virtualenv, install pip packages system-wide with caution.

Questions or next steps
-----------------------
If you want, I can:
- Add a libcamera capture fallback to `py/app.py`.
- Create a Windows PowerShell-friendly setup script if you plan to test on Windows with a webcam.
- Add small unit tests for the QR URL generation.

Quick test: camera and QR scan
------------------------------
Use the standalone scanner to verify camera + QR decoding:

```
cd py
source venv/bin/activate
python3 qr_scan.py --timeout 30             # uses OpenCV VideoCapture(0)
python3 qr_scan.py --timeout 30 --preview   # shows window if you have a desktop
python3 qr_scan.py --libcamera              # fallback via libcamera-still when OpenCV capture fails
```
If you see "No QR detected", try better lighting, move the code closer, or use the `--libcamera` fallback on Bullseye.

