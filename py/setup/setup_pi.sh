#!/usr/bin/env bash
#set -euo pipefail

# Raspberry Pi setup script for Smart Courier Box (run from the repo's py/ directory)
# - Installs apt dependencies
# - Creates and activates a Python virtualenv
# - Installs Python packages from py/requirements.txt
# Run: sudo bash py/setup_pi.sh  (script will use sudo where needed)

ROOT_UID=0
if [ "$EUID" -ne 0 ]; then
  SUDO=sudo
else
  SUDO=
fi

echo "--- Updating apt and installing system dependencies ---"
$SUDO apt update
$SUDO apt install -y build-essential cmake pkg-config \
  libjpeg-dev libpng-dev libtiff5-dev \
  libavcodec-dev libavformat-dev libswscale-dev \
  libv4l-dev libxvidcore-dev libx264-dev \
  libgtk2.0-dev libatlas-base-dev gfortran \
  python3-dev python3-venv libopenjp2-7 libopenjp2-7-dev \
  libzbar0 libzbar-dev i2c-tools

echo "--- Enabling I2C and camera (interactive) ---"
echo "If prompted, allow raspi-config to enable camera and I2C. If you prefer non-interactive, run: sudo raspi-config nonint do_camera 0 && sudo raspi-config nonint do_i2c 0"
read -p "Do you want to open raspi-config now to enable camera & I2C? (y/N): " yn
yn=${yn:-N}
if [[ "$yn" =~ ^[Yy]$ ]]; then
  $SUDO raspi-config
else
  echo "Skipping interactive raspi-config. Make sure I2C and camera are enabled manually."
fi

# create a virtual environment inside py/venv
VENV_DIR="venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "--- Creating Python virtualenv in $(pwd)/$VENV_DIR ---"
  python3 -m venv "$VENV_DIR"
fi

# activate and install pip packages
echo "--- Activating venv and installing Python packages ---"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip setuptools wheel

REQ_FILE="setup/requirements.txt"
if [ -f "$REQ_FILE" ]; then
  pip install -r "$REQ_FILE"
else
  echo "requirements.txt not found in $(pwd). Installing common packages individually..."
  pip install opencv-python Pillow "qrcode[pil]" pyzbar gpiozero RPi.GPIO luma.oled adafruit-blinka adafruit-circuitpython-ssd1306
fi

# Add common groups for hardware access (may require logout/login to take effect)
echo "--- Adding current user to gpio and video groups (may require reboot) ---"
if [ -n "$SUDO" ]; then
  $SUDO usermod -aG gpio "$SUDO_USER"
  $SUDO usermod -aG video "$SUDO_USER"
else
  usermod -aG gpio "$USER"
  usermod -aG video "$USER"
fi

echo
echo "Setup finished. Recommended next steps:"
echo "  1) Reboot the Pi: sudo reboot"
echo "  2) After reboot, cd into the repo py/ directory and activate the venv: source venv/bin/activate"
echo "  3) Run the app: python3 app.py"
echo

echo "If you encounter OpenCV wheel errors, you may need to install a prebuilt OpenCV package for your Pi or build from source. See py/INSTALLATION.md for troubleshooting."

exit 0
