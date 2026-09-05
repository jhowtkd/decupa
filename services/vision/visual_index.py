"""Índice visual por unidade de fala, via MediaPipe Face/Hand Landmarker.

Contrato de saída (stdout, JSON):
  {"video": "...", "fps": 4, "units": [
     {"id": "u005",
      "look_down_ratio": 0.0, "look_side_ratio": 0.0,
      "hand_on_face_ratio": 0.0, "face_missing_ratio": 0.0,
      "samples": [{"t": 25.5, "look_down": false, "look_side": false,
                   "hand_on_face": false, "face": true}, ...]}, ...]}
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import statistics
import sys
import urllib.request
from pathlib import Path

# Limiares relativos: mediana deste arquivo + margem. Não são graus absolutos.
BLENDSHAPE_MARGIN = 0.12
YAW_MARGIN = 0.20  # ~11,5°
FACE_BBOX_EXPAND = 0.25

FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)

HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / ".models"

_log = logging.getLogger("decupa-vision")


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


def calibrate_threshold(values: list[float], margin: float) -> float:
    return median(values) + margin


def ratio(flags: list[bool]) -> float:
    if not flags:
        return 0.0
    return sum(1 for f in flags if f) / len(flags)


def load_units(index_path: str) -> list[dict]:
    raw = json.loads(Path(index_path).read_text(encoding="utf-8"))
    units = raw.get("units")
    if not isinstance(units, list) or len(units) == 0:
        raise SystemExit("speech_index.json sem `units`")
    return [
        {"id": str(u["id"]), "start": float(u["start"]), "end": float(u["end"])}
        for u in units
    ]


def aggregate_units(units: list[dict], samples: list[dict]) -> list[dict]:
    """Agrupa samples por unidade usando o intervalo [start, end) do índice."""
    out: list[dict] = []
    for unit in units:
        owned = [s for s in samples if unit["start"] <= s["t"] < unit["end"]]
        out.append(
            {
                "id": unit["id"],
                "look_down_ratio": ratio([s["look_down"] for s in owned]),
                "look_side_ratio": ratio([s["look_side"] for s in owned]),
                "hand_on_face_ratio": ratio([s["hand_on_face"] for s in owned]),
                "face_missing_ratio": ratio([not s["face"] for s in owned]),
                "samples": owned,
            }
        )
    return out


def blendshape_map(categories: list) -> dict[str, float]:
    return {c.category_name: float(c.score) for c in categories}


def look_down_score(shapes: dict[str, float]) -> float:
    return (
        shapes.get("eyeLookDownLeft", 0.0) + shapes.get("eyeLookDownRight", 0.0)
    ) / 2.0


def look_side_score(shapes: dict[str, float]) -> float:
    left = abs(shapes.get("eyeLookOutLeft", 0.0) - shapes.get("eyeLookInLeft", 0.0))
    right = abs(shapes.get("eyeLookOutRight", 0.0) - shapes.get("eyeLookInRight", 0.0))
    return (left + right) / 2.0


def yaw_from_matrix(matrix) -> float:
    """Yaw em radianos a partir da matriz 4×4 de transformação facial."""
    r00 = float(matrix[0][0])
    r20 = float(matrix[2][0])
    return math.atan2(-r20, r00)


def face_bbox(landmarks) -> tuple[float, float, float, float]:
    xs = [lm.x for lm in landmarks]
    ys = [lm.y for lm in landmarks]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    w, h = x1 - x0, y1 - y0
    return (
        x0 - w * FACE_BBOX_EXPAND,
        y0 - h * FACE_BBOX_EXPAND,
        x1 + w * FACE_BBOX_EXPAND,
        y1 + h * FACE_BBOX_EXPAND,
    )


def hand_in_bbox(hand_landmarks, bbox: tuple[float, float, float, float]) -> bool:
    x0, y0, x1, y1 = bbox
    return any(x0 <= lm.x <= x1 and y0 <= lm.y <= y1 for lm in hand_landmarks)


def ensure_model(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    _log.info("baixando %s", dest.name)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(dest)
    return dest


def mediapipe_missing_message() -> str:
    return (
        "MediaPipe não está instalado. Veja services/vision/README.md "
        "(uv sync --python 3.12)."
    )


def analyze(video: str, fps: int) -> list[dict]:
    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError:
        print(mediapipe_missing_message(), file=sys.stderr)
        raise SystemExit(1)

    face_model = ensure_model(FACE_MODEL_URL, MODELS_DIR / "face_landmarker.task")
    hand_model = ensure_model(HAND_MODEL_URL, MODELS_DIR / "hand_landmarker.task")

    # CPU: o grafo GPU/Metal aborta no macOS (`DrishtiMetalHelper`, service_).
    cpu = python.BaseOptions.Delegate.CPU
    face_landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(face_model), delegate=cpu),
            running_mode=vision.RunningMode.VIDEO,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
            num_faces=1,
        )
    )
    hand_landmarker = vision.HandLandmarker.create_from_options(
        vision.HandLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(hand_model), delegate=cpu),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=2,
        )
    )

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(f"não consegui abrir o vídeo {video}", file=sys.stderr)
        raise SystemExit(1)

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    raw: list[dict] = []
    idx = 0
    next_t = 0.0
    step = 1.0 / fps if fps > 0 else 0.25

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = idx / src_fps
            idx += 1
            if t + 1e-9 < next_t:
                continue
            next_t += step

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            ts_ms = int(round(t * 1000))
            face_res = face_landmarker.detect_for_video(image, ts_ms)
            hand_res = hand_landmarker.detect_for_video(image, ts_ms)

            has_face = bool(face_res.face_landmarks)
            down_s = 0.0
            side_s = 0.0
            yaw_s = 0.0
            bbox = None
            if has_face:
                shapes = blendshape_map(face_res.face_blendshapes[0])
                down_s = look_down_score(shapes)
                side_s = look_side_score(shapes)
                if face_res.facial_transformation_matrixes:
                    yaw_s = abs(yaw_from_matrix(face_res.facial_transformation_matrixes[0]))
                bbox = face_bbox(face_res.face_landmarks[0])

            hand_near = False
            if bbox is not None:
                for hand in hand_res.hand_landmarks:
                    if hand_in_bbox(hand, bbox):
                        hand_near = True
                        break

            raw.append(
                {
                    "t": t,
                    "look_down_score": down_s,
                    "look_side_score": side_s,
                    "yaw": yaw_s,
                    "hand_on_face": hand_near,
                    "face": has_face,
                }
            )
    finally:
        cap.release()
        face_landmarker.close()
        hand_landmarker.close()

    faced = [r for r in raw if r["face"]]
    down_th = calibrate_threshold([r["look_down_score"] for r in faced], BLENDSHAPE_MARGIN)
    side_th = calibrate_threshold([r["look_side_score"] for r in faced], BLENDSHAPE_MARGIN)
    yaw_th = calibrate_threshold([r["yaw"] for r in faced], YAW_MARGIN)

    samples: list[dict] = []
    for r in raw:
        look_down = bool(r["face"] and r["look_down_score"] > down_th)
        look_side = bool(
            r["face"] and (r["look_side_score"] > side_th or r["yaw"] > yaw_th)
        )
        samples.append(
            {
                "t": round(r["t"], 3),
                "look_down": look_down,
                "look_side": look_side,
                "hand_on_face": bool(r["hand_on_face"]),
                "face": bool(r["face"]),
            }
        )
    return samples


def main() -> int:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--fps", type=int, default=4)
    args = parser.parse_args()

    units = load_units(args.index)
    samples = analyze(args.video, args.fps)
    payload = {
        "video": args.video,
        "fps": args.fps,
        "units": aggregate_units(units, samples),
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
