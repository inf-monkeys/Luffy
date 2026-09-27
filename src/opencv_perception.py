#!/usr/bin/env python3
"""Game-agnostic local image summary for capture-card footage."""
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
    gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    brightness = float(gray_frame.mean())
    has_signal = brightness >= 3.0
    # Quantized color map keeps rough shapes and screen layout available to a
    # text-only reasoning model. Glyphs represent dominant colors, not objects.
    grid_w, grid_h = 64, 36
    small = cv2.cvtColor(cv2.resize(frame, (grid_w, grid_h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    palette = np.array([
        [20, 20, 20], [220, 55, 50], [55, 175, 75], [235, 205, 55],
        [55, 100, 220], [185, 65, 185], [45, 180, 190], [225, 225, 225],
    ], dtype=np.int16)
    glyphs = np.array(list(".RGYBMCW"))
    pixels = small.astype(np.int16)
    distances = ((pixels[:, :, None, :] - palette[None, None, :, :]) ** 2).sum(axis=3)
    indexes = distances.argmin(axis=2)
    ascii_map = "\n".join("".join(glyphs[row]) for row in indexes)

    motion = []
    scene_change_ratio = None
    previous_data = request.get("previousImageData")
    if previous_data:
        previous_match = re.match(r"data:image/(?:png|jpeg|webp);base64,(.*)", previous_data)
        if previous_match:
            previous = cv2.imdecode(np.frombuffer(base64.b64decode(previous_match.group(1)), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            current = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if previous is not None and previous.shape == current.shape:
                diff = cv2.absdiff(previous, current)
                scene_change_ratio = round(float(np.count_nonzero(diff > 24) / diff.size), 4)
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
        "screen_type": "unknown",
        "visual_map_format": "64x36 color-quantized ASCII; symbols encode approximate color only",
        "visual_map": ascii_map,
        "motion_regions": motion,
        "scene_change_ratio": scene_change_ratio,
        "frame": {"width": width, "height": height},
        "perception": "local_opencv_color_map_and_motion",
        "confidence": 0.62 if has_signal else 0.05,
        "semantic_confidence": 0.1,
        "uncertainty": [
            "The ASCII map preserves coarse colors and layout only; it does not identify objects or game mechanics.",
            "Motion regions are pixel changes, not recognized entities.",
            "Use the configured game, objective and user notes. Jev should choose WAIT when the visual summary is insufficient."
        ]
    }
    output["screen_brightness"] = round(brightness, 2)
    output["signal_detected"] = has_signal
    if not has_signal:
        output["uncertainty"].insert(0, "Captured frame is nearly black; OBS may have no active video signal.")
    # The prior frame is sent only between local subprocess calls, never to Jev.
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
