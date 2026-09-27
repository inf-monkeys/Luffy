#!/usr/bin/env python3
"""Conservative local frame diagnostics for FC26 capture-card footage.

OpenCV can locate a likely pitch and frame-to-frame motion without uploading the
capture. It cannot reliably identify the controlled player, possession, ball,
or tactics from color/motion alone, so this module explicitly abstains.
"""
import base64
import json
import re
import sys

import cv2
import numpy as np


def main():
    request = json.load(sys.stdin)
    match = re.match(r"data:image/(?:png|jpeg|webp);base64,(.*)", request.get("imageData", ""))
    if not match:
        raise ValueError("imageData must be a base64 PNG, JPEG, or WebP data URL")
    raw = base64.b64decode(match.group(1), validate=True)
    frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("OpenCV could not decode the image")
    height, width = frame.shape[:2]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # Broad green masks tolerate broadcast/game pitch shades but exclude most HUD.
    green = cv2.inRange(hsv, np.array([30, 35, 25]), np.array([100, 255, 255]))
    green = cv2.morphologyEx(green, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    green = cv2.morphologyEx(green, cv2.MORPH_CLOSE, np.ones((17, 17), np.uint8))
    contours, _ = cv2.findContours(green, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = [c for c in contours if cv2.contourArea(c) >= width * height * 0.035]
    contours.sort(key=cv2.contourArea, reverse=True)
    pitch = None
    pitch_coverage = 0.0
    if contours:
        x, y, w, h = cv2.boundingRect(contours[0])
        pitch = {"x": round(x / width, 4), "y": round(y / height, 4),
                 "width": round(w / width, 4), "height": round(h / height, 4)}
        pitch_coverage = cv2.contourArea(contours[0]) / (width * height)

    motion = []
    previous_data = request.get("previousImageData")
    if previous_data:
        previous_match = re.match(r"data:image/(?:png|jpeg|webp);base64,(.*)", previous_data)
        if previous_match:
            previous = cv2.imdecode(np.frombuffer(base64.b64decode(previous_match.group(1)), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            current = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if previous is not None and previous.shape == current.shape:
                diff = cv2.absdiff(previous, current)
                _, moving = cv2.threshold(diff, 24, 255, cv2.THRESH_BINARY)
                moving = cv2.morphologyEx(moving, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
                count, labels, stats, centroids = cv2.connectedComponentsWithStats(moving)
                for i in range(1, count):
                    area = int(stats[i, cv2.CC_STAT_AREA])
                    if 20 <= area <= width * height * 0.002:
                        cx, cy = centroids[i]
                        motion.append({"x": round(float(cx / width), 4), "y": round(float(cy / height), 4), "pixels": area})
                motion = sorted(motion, key=lambda item: item["pixels"], reverse=True)[:40]

    output = {
        "phase": "unknown",
        "scoreboard": {"home": None, "away": None, "clock": None},
        "ball": {"x": None, "y": None, "confidence": 0.0},
        "controlled_player": {"x": None, "y": None, "confidence": 0.0},
        "visible_players": [],
        "possession": "unknown",
        "attack_direction": "unknown",
        "on_screen_hints": [],
        "pitch_region": pitch,
        "pitch_green_coverage": round(pitch_coverage, 4),
        "motion_regions": motion,
        "frame": {"width": width, "height": height},
        "perception": "opencv_classical_local",
        "confidence": 0.15 if pitch else 0.05,
        "uncertainty": [
            "OpenCV pitch and motion regions are not player or ball detections.",
            "Controlled player, team, possession, score and clock need a validated game-specific detector or human annotation.",
            "No button recommendation is safe from this frame alone; abstain until game state perception is validated."
        ]
    }
    # The prior frame is sent only between local subprocess calls, never to Jev.
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
