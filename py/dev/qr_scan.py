#!/usr/bin/env python3
"""
Fast, headless QR scanner for Raspberry Pi (libcamera-first).

Features
- Uses Picamera2 (libcamera) by default (no preview, optimized for speed)
- Decodes using pyzbar; falls back to OpenCV's QRCodeDetector
- Fallbacks: libcamera-still snapshot loop, then OpenCV VideoCapture(0)

Usage
    python3 py/qr_scan.py                  # libcamera (Picamera2) headless scan until found
    python3 py/qr_scan.py --timeout 30     # limit scan time
    python3 py/qr_scan.py --backend opencv --device 0   # force OpenCV backend
    python3 py/qr_scan.py --backend libcamera-still     # force libcamera-still fallback

Dependencies
- opencv-python (preview window and drawing)
- pyzbar + libzbar0 (apt) for best decode performance
- Picamera2 (recommended on Bullseye/Bookworm): install via apt: sudo apt install -y python3-picamera2
 - qrcode[pil] (to generate the output QR image)
"""

from __future__ import annotations

import argparse
import base64
import subprocess
import sys
import time
from typing import Optional, Tuple

try:
    import cv2
except Exception as e:
    print("Error: OpenCV (cv2) is required. Install with: pip install opencv-python", file=sys.stderr)
    raise

try:
    from pyzbar import pyzbar  # type: ignore
    HAVE_PYZBAR = True
except Exception:
    HAVE_PYZBAR = False

import numpy as np
import random
import re
import qrcode

# Reuse OpenCV QRCodeDetector to avoid per-frame construction cost
_QR_DETECTOR = None
def _get_qr_detector():
    global _QR_DETECTOR
    if _QR_DETECTOR is None:
        _QR_DETECTOR = cv2.QRCodeDetector()
    return _QR_DETECTOR

# Picamera2 (libcamera) backend
try:
    from picamera2 import Picamera2  # type: ignore
    HAVE_PICAMERA2 = True
except Exception:
    HAVE_PICAMERA2 = False


def open_camera(index: int = 0, width: Optional[int] = None, height: Optional[int] = None):
    cap = cv2.VideoCapture(index)
    if width:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    if height:
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if not cap.isOpened():
        return None
    return cap


def decode_qr(frame) -> Tuple[Optional[str], Optional[Tuple[int, int, int, int]]]:
    """Return (text, bbox) where bbox is (x, y, w, h) for the first QR found."""
    # Convert once to grayscale for faster decode
    try:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    except Exception:
        gray = frame

    if HAVE_PYZBAR:
        decoded = pyzbar.decode(gray)
        if decoded:
            d = decoded[0]
            text = d.data.decode('utf-8', errors='ignore')
            # pyzbar rect: left, top, width, height
            r = d.rect
            return text, (r.left, r.top, r.width, r.height)

    # Fallback: OpenCV's QRCodeDetector
    detector = _get_qr_detector()
    text, points, _ = detector.detectAndDecode(gray)
    if text:
        bbox = None
        if points is not None and len(points) > 0:
            pts = points.reshape(-1, 2)
            x, y, w, h = cv2.boundingRect(pts.astype(np.float32))
            bbox = (int(x), int(y), int(w), int(h))
        return text, bbox
    return None, None


def scan_with_picamera2(timeout: float, width: Optional[int], height: Optional[int]) -> Optional[str]:
    """Use Picamera2 (libcamera) to stream and scan for QR headlessly."""
    if not HAVE_PICAMERA2:
        return None
    picam = Picamera2()
    # Prefer video-size for speed; typical 1280x720 works well
    w = width or 1280
    h = height or 720
    try:
        config = picam.create_video_configuration(main={"size": (w, h), "format": "RGB888"})
        picam.configure(config)
        picam.start()
    except Exception:
        try:
            picam.close()
        except Exception:
            pass
        return None

    deadline = time.time() + timeout if timeout > 0 else float('inf')
    try:
        while time.time() < deadline:
            # Capture frame (RGB) and convert for OpenCV drawing
            arr = picam.capture_array()
            if arr is None:
                continue
            frame = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            text, _ = decode_qr(frame)
            if text:
                return text
        return None
    finally:
        try:
            picam.stop()
        except Exception:
            pass


def scan_with_opencv(device: int, timeout: float, width: Optional[int], height: Optional[int]) -> Optional[str]:
    cap = open_camera(device, width, height)
    if cap is None:
        return None
    deadline = time.time() + timeout if timeout > 0 else float('inf')
    try:
        while time.time() < deadline:
            ok, frame = cap.read()
            if not ok:
                continue
            text, _ = decode_qr(frame)
            if text:
                return text
    finally:
        try:
            cap.release()
        except Exception:
            pass
    return None


def grab_libcamera_still(width: int = 640, height: int = 480, timeout_ms: int = 1_000) -> Optional[np.ndarray]:
    """Capture one JPEG frame from libcamera-still to stdout and return as BGR image."""
    cmd = [
        'libcamera-still',
        '-n',              # no preview
        '-t', str(timeout_ms),
        '--width', str(width),
        '--height', str(height),
        '-o', '-',         # output to stdout
    ]
    try:
        proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        data = proc.stdout
        if not data:
            return None
        img_array = np.frombuffer(data, dtype=np.uint8)
        frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        return frame
    except FileNotFoundError:
        # libcamera-still not installed
        return None
    except subprocess.CalledProcessError:
        return None


def scan_with_libcamera(timeout: float, width: int = 640, height: int = 480) -> Optional[str]:
    deadline = time.time() + timeout if timeout > 0 else float('inf')
    while time.time() < deadline:
        # Shorter capture timeout for more frequent sampling
        frame = grab_libcamera_still(width=width, height=height, timeout_ms=250)
        if frame is None:
            # If libcamera-still missing or failed, stop trying
            return None
        text, _ = decode_qr(frame)
        if text:
            return text
    return None


def looks_like_email_b64(token: str) -> Optional[str]:
    """Return decoded email if token is base64-encoded email, else None."""
    try:
        decoded = base64.b64decode(token, validate=True).decode('utf-8', errors='ignore')
        # Simple email pattern
        if re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", decoded):
            return decoded
        return None
    except Exception:
        return None


def generate_pickup_qr(email_b64: str, code_plain: str, out_path: str) -> str:
    """Build simulator URL and save QR to out_path. Returns the URL."""
    code_b64 = base64.b64encode(code_plain.encode('utf-8')).decode('utf-8')
    url = f"https://smart-courier-box.vercel.app/p?e={email_b64}&c={code_b64}"
    qr = qrcode.QRCode(box_size=8, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(out_path)
    return url


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='Scan for a recipient email QR, then generate and save the pickup QR image.')
    p.add_argument('--timeout', type=float, default=60.0, help='Seconds to scan before giving up (<=0 for no timeout)')
    p.add_argument('--width', type=int, default=None, help='Requested capture width')
    p.add_argument('--height', type=int, default=None, help='Requested capture height')
    p.add_argument('--backend', choices=['auto', 'picamera2', 'libcamera-still', 'opencv'], default='auto',
                   help='Camera backend to use (default: auto -> picamera2 if available, else libcamera-still, else opencv)')
    p.add_argument('--device', type=int, default=0, help='OpenCV camera device index (used if backend=opencv)')
    p.add_argument('--libcamera', action='store_true', help='Deprecated: same as --backend libcamera-still')
    p.add_argument('--output', '-o', default='pickup_qr.png', help='Output QR image filename (default: pickup_qr.png)')
    args = p.parse_args(argv)

    # Normalize deprecated flag
    backend = args.backend
    if args.libcamera:
        backend = 'libcamera-still'

    # Backend selection order
    if backend == 'auto':
        # Try Picamera2 (headless)
        token = scan_with_picamera2(timeout=args.timeout, width=args.width, height=args.height)
        if token is None:
            # Try libcamera-still loop (headless)
            token = scan_with_libcamera(timeout=args.timeout,
                                        width=args.width or 640, height=args.height or 480)
        if token is None:
            # Fallback: OpenCV
            token = scan_with_opencv(device=args.device, timeout=args.timeout,
                                     width=args.width, height=args.height)
        if token is None:
            print('No QR detected', file=sys.stderr)
            return 2
        # Validate base64 email
        email = looks_like_email_b64(token)
        if not email:
            print('Scanned QR is not a base64-encoded email expected by simulator', file=sys.stderr)
            return 3
        # Generate 4-digit code, save QR image matching simulator URL pattern
        code_plain = str(random.randint(1000, 9999))
        url = generate_pickup_qr(token, code_plain, args.output)
        print(f'Saved {args.output}')
        print(f'Pickup code: {code_plain}')
        print(url)
        return 0

    if backend == 'picamera2':
        token = scan_with_picamera2(timeout=args.timeout, width=args.width, height=args.height)
        if token:
            email = looks_like_email_b64(token)
            if not email:
                print('Scanned QR is not a base64-encoded email expected by simulator', file=sys.stderr)
                return 3
            code_plain = str(random.randint(1000, 9999))
            url = generate_pickup_qr(token, code_plain, args.output)
            print(f'Saved {args.output}')
            print(f'Pickup code: {code_plain}')
            print(url)
            return 0
        print('No QR detected (picamera2)', file=sys.stderr)
        return 2

    if backend == 'libcamera-still':
        token = scan_with_libcamera(timeout=args.timeout,
                                    width=args.width or 640, height=args.height or 480)
        if token:
            email = looks_like_email_b64(token)
            if not email:
                print('Scanned QR is not a base64-encoded email expected by simulator', file=sys.stderr)
                return 3
            code_plain = str(random.randint(1000, 9999))
            url = generate_pickup_qr(token, code_plain, args.output)
            print(f'Saved {args.output}')
            print(f'Pickup code: {code_plain}')
            print(url)
            return 0
        print('No QR detected (libcamera-still)', file=sys.stderr)
        return 2

    if backend == 'opencv':
        token = scan_with_opencv(device=args.device, timeout=args.timeout,
                                 width=args.width, height=args.height)
        if token:
            email = looks_like_email_b64(token)
            if not email:
                print('Scanned QR is not a base64-encoded email expected by simulator', file=sys.stderr)
                return 3
            code_plain = str(random.randint(1000, 9999))
            url = generate_pickup_qr(token, code_plain, args.output)
            print(f'Saved {args.output}')
            print(f'Pickup code: {code_plain}')
            print(url)
            return 0
        print('No QR detected (opencv)', file=sys.stderr)
        return 2

    print('Invalid backend selection', file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Interrupted', file=sys.stderr)
        sys.exit(130)
