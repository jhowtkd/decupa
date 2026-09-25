"""Segmentos do corte duro da exportação MP4 com VideoToolbox, quando compensa.

O motor de condense corta cada trecho com libx264 (veryfast, crf 18) na
resolução cheia. Medido na exportação completa, com o motor real:

    origem                  libx264   VideoToolbox (decodifica + codifica)
    DJI HEVC 10-bit 3K      130,2 s    89,3 s  (-31%)
    4K H.264                 57,2 s    82,4 s  (pior: trazer 4K da GPU custa)
    540p H.264                8,2 s    19,9 s  (pior: abrir o VT a cada corte)

Por isso o VideoToolbox só entra quando a origem é HEVC, onde a decodificação
em software é o gargalo. Qualidade constante 68: SSIM 0,9526 contra 0,9523 do
crf 18 no DJI, arquivo ~19% maior.

`install(engine)` envolve o `_cut_segment` do motor pinado e troca só o
codificador/decodificador do comando FFmpeg daquele segmento; escala, pad,
declick de 8 ms e silêncio sintético continuam sendo do motor. Se o
VideoToolbox falhar, o segmento é refeito com o comando original e
`state["mixed"]` fica verdadeiro: a junção por cópia não mistura segmentos de
codificadores diferentes. DECUPA_RENDER_SOFTWARE=1 desliga.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

VT_VIDEO_ARGS = ["-c:v", "h264_videotoolbox", "-q:v", "68", "-allow_sw", "0"]
HW_SOURCE_CODECS = {"hevc"}

state: dict[str, Any] = {"mixed": False, "hardware": 0, "software": 0}
_codec_cache: dict[str, str] = {}


def vt_command(cmd: list[str]) -> list[str] | None:
    """Versão VideoToolbox do comando de segmento do motor, ou None se não reconhecer."""
    try:
        c = cmd.index("-c:v")
        i = cmd.index("-i")
    except ValueError:
        return None
    if cmd[c + 1] != "libx264" or "-crf" not in cmd:
        return None
    # -c:v libx264 -preset veryfast -crf N → args do VideoToolbox.
    end = cmd.index("-crf") + 2
    out = cmd[:c] + VT_VIDEO_ARGS + cmd[end:]
    # -hwaccel é opção da primeira entrada (o vídeo de origem): vai antes do
    # -ss/-t que a precedem, ou direto antes do -i.
    at = out.index("-ss") if "-ss" in out[:i] else i
    return out[:at] + ["-hwaccel", "videotoolbox"] + out[at:]


def first_codec(ffprobe_stdout: str) -> str:
    """Primeira linha não vazia: arquivos com grupo de streams (ex.: DJI)
    fazem o ffprobe repetir o codec em mais de uma linha."""
    return next((line.strip() for line in ffprobe_stdout.splitlines() if line.strip()), "")


def source_codec(path: Path | str) -> str:
    key = str(path)
    if key not in _codec_cache:
        try:
            proc = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name", "-of", "csv=p=0", key],
                capture_output=True, text=True, timeout=30,
            )
            _codec_cache[key] = first_codec(proc.stdout) if proc.returncode == 0 else ""
        except Exception:  # noqa: BLE001 - sem probe, fica no libx264
            _codec_cache[key] = ""
    return _codec_cache[key]


def install(
    engine: Any,
    platform: str = sys.platform,
    probe: Callable[[Path | str], str] = source_codec,
) -> bool:
    """Envolve `engine._cut_segment`; devolve True quando instalou."""
    if platform != "darwin" or os.environ.get("DECUPA_RENDER_SOFTWARE") == "1":
        return False
    original_cut: Callable[..., str | None] | None = getattr(engine, "_cut_segment", None)
    original_run = getattr(engine, "run_proc", None)
    if original_cut is None or original_run is None:
        return False

    def count(kind: str) -> None:
        state[kind] += 1
        state["mixed"] = state["hardware"] > 0 and state["software"] > 0

    def run_vt(cmd: list[str], *args: Any, **kwargs: Any) -> Any:
        hw = vt_command(cmd)
        if hw is None:
            return original_run(cmd, *args, **kwargs)
        proc = original_run(hw, *args, **kwargs)
        if proc.returncode == 0:
            count("hardware")
            return proc
        print("[aviso] VideoToolbox falhou no segmento, refazendo em libx264", file=sys.stderr)
        proc = original_run(cmd, *args, **kwargs)
        count("software")
        return proc

    def cut_segment(video_path: Any, *args: Any, **kwargs: Any) -> str | None:
        if probe(video_path) not in HW_SOURCE_CODECS:
            count("software")
            return original_cut(video_path, *args, **kwargs)
        engine.run_proc = run_vt
        try:
            return original_cut(video_path, *args, **kwargs)
        finally:
            engine.run_proc = original_run

    engine._cut_segment = cut_segment
    return True
