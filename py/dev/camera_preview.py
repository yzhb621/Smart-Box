#!/usr/bin/env python3
"""
Live camera preview for Raspberry Pi.

Features
- OpenCV VideoCapture live view with FPS overlay
- Optional rotation and horizontal/vertical flip
- Press 'q' or ESC to quit, 's' to save a snapshot
- Optional fallback: run libcamera-hello for preview on Bullseye

Examples
  python3 camera_preview.py
  python3 camera_preview.py --width 1280 --height 720 --hflip --rotate 180
  python3 camera_preview.py --libcamera --width 1280 --height 720
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import subprocess
from datetime import datetime

try:
    import cv2  # type: ignore
except Exception:
    cv2 = None


def rotate_frame(frame, angle: int):
    if angle == 0:
        return frame
    if angle == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    if angle == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    if angle == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


def preview_opencv(device: int, width: int | None, height: int | None, rotate: int, hflip: bool, vflip: bool, title: str = 'Camera Preview') -> int:
    if cv2 is None:
        return 2
    cap = cv2.VideoCapture(device)
    if width:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    if height:
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if not cap.isOpened():
        return 2

    last = time.time()
    fps = 0.0
    ok_frames = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            ok_frames += 1
            # transforms
            if hflip:
                frame = cv2.flip(frame, 1)
            if vflip:
                frame = cv2.flip(frame, 0)
            if rotate:
                frame = rotate_frame(frame, rotate)

            # FPS overlay (simple moving estimate)
            now = time.time()
            dt = now - last
            if dt >= 0.5:
                fps = ok_frames / dt
                ok_frames = 0
                last = now
            h, w = frame.shape[:2]
            cv2.putText(frame, f"{w}x{h}  {fps:4.1f} FPS  [q]=quit [s]=snap", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

            cv2.imshow(title, frame)
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord('q')):  # ESC or q
                return 0
            if key == ord('s'):
                ts = datetime.now().strftime('%Y%m%d_%H%M%S')
                out = f"snapshot_{ts}.jpg"
                try:
                    cv2.imwrite(out, frame)
                    print(f"Saved {out}")
                except Exception as e:
                    print(f"Failed to save snapshot: {e}", file=sys.stderr)
    finally:
        try:
            cap.release()
        except Exception:
            pass
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass


def preview_libcamera(width: int | None, height: int | None) -> int:
    cmd = ['libcamera-hello', '-t', '0']  # run until Ctrl+C
    if width:
        cmd += ['--width', str(width)]
    if height:
        cmd += ['--height', str(height)]
    try:
        # Will open its own preview window
        return subprocess.call(cmd)
    except FileNotFoundError:
        print('libcamera-hello not found', file=sys.stderr)
        return 2


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='Show a live camera view from the Raspberry Pi camera.')
    p.add_argument('--device', type=int, default=0, help='OpenCV camera index (default: 0)')
    p.add_argument('--width', type=int, default=None, help='Requested width')
    p.add_argument('--height', type=int, default=None, help='Requested height')
    p.add_argument('--rotate', type=int, choices=(0, 90, 180, 270), default=0, help='Rotate preview by N degrees')
    p.add_argument('--hflip', action='store_true', help='Horizontal flip (mirror)')
    p.add_argument('--vflip', action='store_true', help='Vertical flip')
    p.add_argument('--libcamera', action='store_true', help='Use libcamera-hello instead of OpenCV')
    args = p.parse_args(argv)

    if args.libcamera:
        return preview_libcamera(args.width, args.height)

    rc = preview_opencv(args.device, args.width, args.height, args.rotate, args.hflip, args.vflip)
    if rc == 0:
        return 0
    # fallback
    return preview_libcamera(args.width, args.height)


if __name__ == '__main__':
    sys.exit(main())
