"""Compose at most two JPEG screenshots without requiring Pillow."""
import base64
import json
import os
import subprocess
import sys
import tempfile


request = json.load(sys.stdin)
values = [item for item in request.get("memory_images", []) if isinstance(item, str) and ";base64," in item][-1:]
values.append(request["image"])
if len(values) == 1:
    print(values[0])
    raise SystemExit

with tempfile.TemporaryDirectory(prefix="luffy-evidence-") as directory:
    paths = []
    for index, value in enumerate(values):
        _, encoded = value.split(";base64,", 1)
        path = os.path.join(directory, f"frame-{index}.jpg")
        with open(path, "wb") as output:
            output.write(base64.b64decode(encoded))
        paths.append(path)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", paths[0], "-i", paths[1],
        "-filter_complex", "[0:v]scale=480:-2[a];[1:v]scale=480:-2[b];[a][b]hstack=inputs=2",
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1",
    ]
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    print("data:image/jpeg;base64," + base64.b64encode(result.stdout).decode("ascii"))
