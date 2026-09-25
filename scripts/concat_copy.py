"""Concatenação do corte duro da exportação MP4 sem recodificar o vídeo.

O motor de condense normaliza cada segmento (mesmo tamanho, SAR, fps,
yuv420p e libx264) justamente para o concat demuxer, mas depois recodifica o
vídeo inteiro na junção — no 4K isso era ~40% do tempo da exportação. Aqui o
vídeo vai por cópia; só o áudio é recodificado, uma vez, para não acumular o
priming do AAC de cada segmento como dessincronia.

Sem dependência do motor: `install(engine)` troca o `_concat_hard` do módulo
do motor pinado e, se a cópia falhar, cai na concatenação original.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


def concat_video_copy(segments: list[dict[str, Any]], output_path: Path | str, *, crf: int) -> str | None:
    """Devolve None em sucesso, ou a mensagem de erro (contrato do motor)."""
    del crf  # sem recodificação de vídeo, o CRF não se aplica
    concat_file = Path(segments[0]["path"]).parent / "concat.txt"
    concat_file.write_text(
        "".join(f"file '{Path(s['path']).as_posix()}'\n" for s in segments),
        encoding="utf-8",
    )
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart",
        str(output_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    except Exception as exc:  # noqa: BLE001 - qualquer falha cai no motor
        return str(exc)
    return None if proc.returncode == 0 else (proc.stderr or "").strip()[-1500:] or "ffmpeg falhou"


def install(engine: Any) -> bool:
    """Troca `engine._concat_hard` pela versão por cópia, com fallback.

    DECUPA_CONCAT_REENCODE=1 mantém a concatenação original (comparação A/B).
    Devolve True quando a troca foi feita.
    """
    if os.environ.get("DECUPA_CONCAT_REENCODE") == "1":
        return False
    original: Callable[..., str | None] | None = getattr(engine, "_concat_hard", None)
    if original is None:
        return False

    def concat_hard(segments: list[dict[str, Any]], output_path: Path, *, crf: int) -> str | None:
        error = concat_video_copy(segments, output_path, crf=crf)
        if error is None:
            return None
        print(f"[aviso] concat por cópia falhou, recodificando: {error[-300:]}", file=sys.stderr)
        return original(segments, output_path, crf=crf)

    engine._concat_hard = concat_hard
    return True
