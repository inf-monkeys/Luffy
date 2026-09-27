"""Local HTTP adapter for the Luffy OmniJev-4B MLX decision runtime.

The gateway speaks the same typed-choice shape as jev-visual. This adapter
loads the locally converted OmniJev-4B 5-bit Qwen3.5 model and its released
decision head, keeping MLX and model-specific details behind the HTTP boundary.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, HTTPException
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = Path(
    os.environ.get(
        "JEV_OMNI_MODEL_PATH",
        str(ROOT / "third_party" / "OmniJev" / "models" / "Qwen3.5-4B-OmniJev-MLX-5bit"),
    )
).expanduser().resolve()
HEAD_PATH = Path(
    os.environ.get(
        "JEV_OMNI_HEAD_PATH",
        str(ROOT / "third_party" / "OmniJev" / "models" / "OmniJev-4B-ckpt" / "head.npz"),
    )
).expanduser().resolve()
MAX_PIXELS = max(28 * 28, int(os.environ.get("JEV_OMNI_MAX_PIXELS", "87808")))


def _load_classifier():
    # Reuse the exact MLX adapter and OmniJev decision head used by the paired
    # benchmark so serving and evaluation cannot silently diverge.
    source = str(ROOT / "training")
    if source not in sys.path:
        sys.path.insert(0, source)
    from benchmark_omnijev_mlx import OmniHead, load_adapter, predict_image

    adapter, model_source, revision = load_adapter(str(MODEL_PATH))
    adapter.processor.image_processor.max_pixels = MAX_PIXELS
    head = OmniHead(HEAD_PATH)

    class OmniJevClassifier:
        def __init__(self):
            self.adapter = adapter
            self.head = head
            self.model = model_source
            self.revision = revision
            self.quantization_bits = 5
            self.max_pixels = MAX_PIXELS

        def predict(self, state, instructions, labels, image):
            question = str(instructions or "Choose the best option.")
            if state:
                question = f"{question}\nContext: {state}"
            with self.adapter.execution_context():
                result = predict_image(self.adapter, self.head, image, question, labels)
            probabilities = {
                label: float(value)
                for label, value in zip(labels, result["probabilities"][: len(labels)])
            }
            return {
                "model": self.model,
                "revision": self.revision,
                "probabilities": probabilities,
                "prediction_index": labels.index(result["choice"]),
                "elapsed_ms": float(result["elapsed_ms"]),
                "calibrated": True,
                "quantization_bits": self.quantization_bits,
                "max_pixels": self.max_pixels,
            }

    return OmniJevClassifier()


@asynccontextmanager
async def lifespan(app: FastAPI):
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jev-omni")
    app.state.executor = executor
    app.state.classifier = await asyncio.get_running_loop().run_in_executor(
        executor, _load_classifier
    )
    app.state.lock = Lock()
    yield
    executor.shutdown(wait=True)


app = FastAPI(title="Luffy local Jev-Omni adapter", lifespan=lifespan)


def _decode_image(value: Any) -> Image.Image:
    if not isinstance(value, str) or ";base64," not in value:
        raise HTTPException(422, "image must be a base64 data URL")
    header, encoded = value.split(";base64,", 1)
    if header not in {"data:image/png", "data:image/jpeg", "data:image/jpg", "data:image/webp"}:
        raise HTTPException(422, "image must be PNG, JPEG, or WebP")
    try:
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as opened:
            return opened.convert("RGB")
    except (ValueError, binascii.Error, OSError) as exc:
        raise HTTPException(422, f"invalid image: {exc}") from exc


def _decode_evidence_sheet(current: Any, memory_images: Any) -> Image.Image:
    """Build a chronological contact sheet so a single-frame head can use round memory."""
    values = memory_images if isinstance(memory_images, list) else []
    values = [item for item in values if isinstance(item, str) and ";base64," in item][-1:]
    values.append(current)
    images = [_decode_image(item) for item in values]
    if len(images) == 1:
        return images[0]
    thumb_w = 480
    thumbs = []
    for image in images:
        ratio = thumb_w / image.width
        thumb = image.resize((thumb_w, max(1, round(image.height * ratio))), Image.Resampling.LANCZOS)
        thumbs.append(thumb)
    cols = 3
    rows = (len(thumbs) + cols - 1) // cols
    cell_h = max(image.height for image in thumbs) + 28
    sheet = Image.new("RGB", (cols * thumb_w, rows * cell_h), "#101820")
    draw = ImageDraw.Draw(sheet)
    for index, image in enumerate(thumbs):
        x = (index % cols) * thumb_w
        y = (index // cols) * cell_h
        sheet.paste(image, (x, y + 24))
        label = "newest" if index == len(thumbs) - 1 else f"older {index + 1}"
        draw.text((x + 8, y + 5), label, fill="#ffffff")
    return sheet


def _options(question: dict[str, Any]) -> tuple[list[str], list[str], str]:
    kind = question.get("type", "choice")
    criteria = question.get("criteria")
    if kind == "noul":
        return ["true", "false"], ["true", "false"], kind
    if kind == "score":
        if not isinstance(criteria, list) or len(criteria) < 2:
            raise HTTPException(422, "score criteria must contain at least 2 labels")
        labels = [str(item) for item in criteria]
        return labels, labels, kind
    if not isinstance(criteria, dict) or len(criteria) < 2:
        raise HTTPException(422, "choice criteria must contain at least 2 options")
    keys = [str(key) for key in criteria]
    labels = [str(criteria[key]) for key in criteria]
    if len(set(labels)) != len(labels):
        raise HTTPException(422, "choice criteria descriptions must be distinct")
    return keys, labels, kind


def _judge(request: dict[str, Any], classifier) -> dict[str, Any]:
    image = _decode_evidence_sheet(request.get("image"), request.get("memory_images"))
    questions = request.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise HTTPException(422, "questions must be a non-empty object")

    state = str(request.get("state", ""))
    answers: dict[str, Any] = {}
    metrics: list[dict[str, Any]] = []
    for key, question in questions.items():
        if not isinstance(question, dict):
            raise HTTPException(422, f"question {key!r} must be an object")
        ids, labels, kind = _options(question)
        result = classifier.predict(
            state,
            str(question.get("instructions", "Choose the best option.")),
            labels,
            image,
        )
        probabilities = {
            option_id: float(result["probabilities"][label])
            for option_id, label in zip(ids, labels)
        }
        selected_index = int(result["prediction_index"])
        answer: dict[str, Any] = {
            "type": kind,
            "probabilities": probabilities,
            "concentration": max(probabilities.values()),
            "scoring": "decision_head",
            "calibrated": bool(result.get("calibrated")),
        }
        if kind == "choice":
            answer["choice"] = ids[selected_index]
        elif kind == "noul":
            answer["noul"] = probabilities[ids[selected_index]] if ids[selected_index] == "true" else probabilities["true"]
        else:
            answer["score"] = selected_index
        answers[key] = answer
        metrics.append({
            "elapsed_ms": result["elapsed_ms"],
            "quantization_bits": result["quantization_bits"],
            "max_pixels": result["max_pixels"],
        })

    elapsed = sum(float(item.get("elapsed_ms", 0)) for item in metrics)
    return {
        "model": result["model"],
        "model_source": str(MODEL_PATH),
        "revision": None,
        "answers": answers,
        "probability_semantics": "normalized candidate probability conditional on supplied candidates; released choice-temperature calibration applied",
        "metrics": {
            "elapsed_ms": elapsed,
            "max_pixels": MAX_PIXELS,
            "quantization_bits": result.get("quantization_bits"),
            "calibrated": bool(result.get("calibrated")),
        },
    }


@app.get("/health")
def health():
    return {
        "ready": hasattr(app.state, "classifier"),
        "model": str(MODEL_PATH),
        "quantization_bits": 5,
        "max_pixels": MAX_PIXELS,
        "head": str(HEAD_PATH),
        "calibrated": True,
    }


@app.post("/v1/judge")
async def judge(request: dict[str, Any]):
    if not hasattr(app.state, "classifier"):
        raise HTTPException(503, "model is still loading")
    loop = asyncio.get_running_loop()
    try:
        with app.state.lock:
            return await loop.run_in_executor(
                app.state.executor,
                _judge,
                request,
                app.state.classifier,
            )
    except HTTPException:
        raise
    except (ValueError, OSError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc
