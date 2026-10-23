"""render_preview sintético: MP4 liso com a duração e o quadro da timeline."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace


def duracao(timeline: dict) -> float:
    """Fim do último clipe, em segundos da montagem (o mesmo que o servidor confere)."""
    fim = 0.0
    for track in timeline.get("tracks", []):
        for clip in track.get("clips", []):
            fim = max(fim, float(clip["timeline_start"]) + float(clip["end"]) - float(clip["start"]))
    return fim


def render_preview(args: dict, _ctx) -> SimpleNamespace:
    timeline = json.loads(Path(args["timeline_path"]).read_text(encoding="utf-8"))
    canvas = timeline.get("output_canvas") or {}
    largura, altura, fps = int(canvas["width"]), int(canvas["height"]), float(canvas["fps"])
    segundos = duracao(timeline)
    quadros = max(1, round(segundos * fps))
    comando = [
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=0x1d2530:s={largura}x{altura}:r={fps}",
        "-frames:v", str(quadros), "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", args["output_path"],
    ]
    feito = subprocess.run(comando, capture_output=True, text=True, check=False)
    if feito.returncode != 0:
        return SimpleNamespace(text=f"[ERROR] motor sintético: {feito.stderr[-800:]}", data={"status": "fail"})
    return SimpleNamespace(text="prévia sintética (plano B do e2e)", data={"status": "ok", "synthetic": True, "frames": quadros})
