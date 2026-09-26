"""Ajustes nos segmentos do corte duro da exportação MP4 da limpeza.

`install(engine)` envolve o `_cut_segment` do motor pinado e reescreve só o
comando FFmpeg de cada segmento; escala, pad, declick de 8 ms e silêncio
sintético continuam sendo do motor. Duas reescritas:

1. Início em zero, sem deriva (todas as plataformas, só no corte duro).
   O motor corta com `-avoid_negative_ts make_zero`, que empurra o começo do
   segmento para depois do atraso dos B-frames do x264 (~67 ms) ou do priming
   do AAC (~21 ms). O concat demuxer desloca cada arquivo pela duração do
   contêiner, então essa folga se soma a cada corte: no DJI de 33 cortes o MP4
   terminava 2,2 s depois do plano que o SRT e a EDL seguem. Sem o make_zero,
   o MP4 guarda esses atrasos em edit lists e o segmento dura exatamente o
   trecho pedido. DECUPA_SEGMENT_MAKE_ZERO=1 mantém o comportamento antigo.

2. VideoToolbox em origens HEVC (macOS). Medido na exportação completa:

       origem                  libx264   VideoToolbox (decodifica + codifica)
       DJI HEVC 10-bit 3K      130,2 s    89,3 s  (-31%)
       4K H.264                 57,2 s    82,4 s  (pior: trazer 4K da GPU custa)
       540p H.264                8,2 s    19,9 s  (pior: abrir o VT a cada corte)

   Qualidade constante 68: SSIM 0,9526 contra 0,9523 do crf 18 no DJI.
   Se o VideoToolbox falhar, o segmento é refeito em libx264 e
   `state["mixed"]` fica verdadeiro quando houver segmentos dos dois: a junção
   por cópia não mistura codificadores. DECUPA_RENDER_SOFTWARE=1 desliga.
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


def is_segment_command(cmd: list[str]) -> bool:
    """Reconhece o comando de `_cut_segment` do motor (libx264 com crf)."""
    return "-c:v" in cmd and "-i" in cmd and "-crf" in cmd \
        and cmd[cmd.index("-c:v") + 1] == "libx264"


def start_at_zero(cmd: list[str]) -> list[str]:
    """Tira `-avoid_negative_ts make_zero`: o atraso vai para a edit list."""
    out = list(cmd)
    if "-avoid_negative_ts" in out:
        k = out.index("-avoid_negative_ts")
        del out[k:k + 2]
    return out


def vt_command(cmd: list[str]) -> list[str] | None:
    """Versão VideoToolbox do comando de segmento do motor, ou None se não reconhecer."""
    if not is_segment_command(cmd):
        return None
    c = cmd.index("-c:v")
    i = cmd.index("-i")
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
    *,
    hard_join: bool = True,
    platform: str = sys.platform,
    probe: Callable[[Path | str], str] = source_codec,
) -> bool:
    """Envolve `engine._cut_segment`; devolve True quando instalou algo."""
    fix_start = hard_join and os.environ.get("DECUPA_SEGMENT_MAKE_ZERO") != "1"
    use_vt = platform == "darwin" and os.environ.get("DECUPA_RENDER_SOFTWARE") != "1"
    original_cut: Callable[..., str | None] | None = getattr(engine, "_cut_segment", None)
    original_run = getattr(engine, "run_proc", None)
    if not (fix_start or use_vt) or original_cut is None or original_run is None:
        return False

    def count(kind: str) -> None:
        state[kind] += 1
        state["mixed"] = state["hardware"] > 0 and state["software"] > 0

    def runner(vt: bool) -> Callable[..., Any]:
        def run(cmd: list[str], *args: Any, **kwargs: Any) -> Any:
            if not is_segment_command(cmd):
                return original_run(cmd, *args, **kwargs)
            base = start_at_zero(cmd) if fix_start else list(cmd)
            if vt:
                proc = original_run(vt_command(base), *args, **kwargs)
                if proc.returncode == 0:
                    count("hardware")
                    return proc
                print("[aviso] VideoToolbox falhou no segmento, refazendo em libx264", file=sys.stderr)
            proc = original_run(base, *args, **kwargs)
            count("software")
            return proc
        return run

    def cut_segment(video_path: Any, *args: Any, **kwargs: Any) -> str | None:
        engine.run_proc = runner(use_vt and probe(video_path) in HW_SOURCE_CODECS)
        try:
            return original_cut(video_path, *args, **kwargs)
        finally:
            engine.run_proc = original_run

    engine._cut_segment = cut_segment
    return True
