#!/usr/bin/env python3
"""
Capture a single photo from the Raspberry Pi camera and save it.

Usage examples:
  python3 capture_photo.py                       # saves photo.jpg from /dev/video0 via OpenCV
  python3 capture_photo.py --output img.jpg      # custom output name
  python3 capture_photo.py --libcamera           # use libcamera-still fallback (Bullseye)
"""

import argparse
import os
import sys
import time
import subprocess

try:
    import cv2  # type: ignore
except Exception as e:
    cv2 = None  # OpenCV may be unavailable; libcamera fallback can still work


def capture_with_opencv(output: str, device: int = 0, width: int | None = None, height: int | None = None, warmup: int = 5) -> bool:
    if cv2 is None:
        return False
    cap = cv2.VideoCapture(device)
    if width:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    if height:
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if not cap.isOpened():
        return False
    try:
        # camera warm-up frames
        for _ in range(max(0, warmup)):
            cap.read()
            time.sleep(0.05)
        ok, frame = cap.read()
        if not ok or frame is None:
            return False
        os.makedirs(os.path.dirname(output) or '.', exist_ok=True)
        return bool(cv2.imwrite(output, frame))
    finally:
        try:
            cap.release()
        except Exception:
            pass


def capture_with_libcamera(output: str, width: int | None = None, height: int | None = None, timeout_ms: int = 1000) -> bool:
    cmd = ['libcamera-still', '-n', '-t', str(timeout_ms), '-o', output]
    if width:
        cmd += ['--width', str(width)]
    if height:
        cmd += ['--height', str(height)]
    try:
        os.makedirs(os.path.dirname(output) or '.', exist_ok=True)
        subprocess.run(cmd, check=True)
        return os.path.isfile(output)
    except FileNotFoundError:
        return False
    except subprocess.CalledProcessError:
        return False


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='Take a photo with the Raspberry Pi camera and save it to a file.')
    p.add_argument('--output', '-o', default='photo.jpg', help='Output image filename (default: photo.jpg)')
    p.add_argument('--device', type=int, default=0, help='OpenCV camera index (default: 0)')
    p.add_argument('--width', type=int, default=None, help='Requested width')
    p.add_argument('--height', type=int, default=None, help='Requested height')
    p.add_argument('--libcamera', action='store_true', help='Force libcamera-still instead of OpenCV')
    args = p.parse_args(argv)

    # Try libcamera first if requested
    if args.libcamera:
        if capture_with_libcamera(args.output, args.width, args.height):
            print(f'Saved {args.output}')
            return 0
        print('libcamera-still failed; no photo saved', file=sys.stderr)
        return 2

    # Default: OpenCV, then fallback to libcamera
    if capture_with_opencv(args.output, device=args.device, width=args.width, height=args.height):
        print(f'Saved {args.output}')
        return 0

    if capture_with_libcamera(args.output, args.width, args.height):
        print(f'Saved {args.output}')
        return 0

    print('Failed to capture photo (OpenCV and libcamera both unavailable or failed)', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
