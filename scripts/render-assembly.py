#!/usr/bin/env python3
"""Renderiza uma montagem Decupa pelo compositor de projeto do motor.

Chama `render_preview` direto — sem transporte MCP. VE_PLUGIN_ROOT aponta para
o clone (default: work/video-agent-kit-plugin, relativo à raiz deste repo).
Imprime result.text e result.data — sem o data a validação do motor some
atrás de uma linha genérica.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Perfis permitidos neste caminho: validado por allowlist, nunca interpolado
# em shell (o motor recebe via argv). vaapi fica de fora porque o motor não
# implementa o setup de device que ele exige.
ALLOWED_ENCODERS = frozenset({"libx264", "h264_videotoolbox", "h264_nvenc"})
ALLOWED_HWACCELS = frozenset({"", "videotoolbox"})


def check_accel_args(encoder: str, hwaccel: str) -> str | None:
    """Devolve a mensagem de erro quando encoder/hwaccel não é permitido."""
    if encoder not in ALLOWED_ENCODERS:
        return f"encoder não suportado neste caminho: {encoder}"
    if hwaccel not in ALLOWED_HWACCELS:
        return f"hwaccel não suportado neste caminho: {hwaccel}"
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeline", required=True, help="JSON da timeline no contrato do motor")
    parser.add_argument("--out", required=True, help="MP4 de referência")
    parser.add_argument("--work", required=True, help="pasta exclusiva da revisão")
    parser.add_argument("--encoder", default="libx264", help="encoder de vídeo da prévia")
    parser.add_argument("--hwaccel", default="", help="backend de aceleração, se houver")
    return parser.parse_args()


def emit(result) -> None:
    text = getattr(result, "text", None)
    print("" if text is None else str(text))
    data = getattr(result, "data", None)
    dumped = {"data": data}
    extra = {
        name: getattr(result, name)
        for name in ("is_error", "error", "message", "details", "errors")
        if hasattr(result, name)
    }
    if extra:
        dumped["result_fields"] = extra
    print(json.dumps(dumped, ensure_ascii=False, default=str))


def load_timeline(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("timeline JSON precisa ser um objeto")
    return payload


def preview_args(
    timeline: dict,
    timeline_path: Path,
    out: Path,
    work: Path,
    encoder: str = "libx264",
    hwaccel: str = "",
) -> dict:
    """Contrato visível tanto em arquivo quanto nos args de render_preview.

    d9fe300: project objeto, assets[] com path, sequence ou output_canvas,
    tracks[] com pista video, reason em todo clipe. validate_timeline_data
    valida o JSON do arquivo; render_preview pode olhar args também.
    """
    project = timeline.get("project")
    if not isinstance(project, dict) or not project:
        project = {
            key: timeline[key]
            for key in ("name", "revision", "width", "height", "fps", "assets", "tracks", "output_canvas", "sequence")
            if key in timeline
        }
    assets = timeline.get("assets")
    if not isinstance(assets, list):
        assets = project.get("assets") if isinstance(project, dict) else None
    tracks = timeline.get("tracks")
    if not isinstance(tracks, list):
        tracks = project.get("tracks") if isinstance(project, dict) else None
    canvas = timeline.get("output_canvas")
    if not isinstance(canvas, dict):
        canvas = project.get("output_canvas") if isinstance(project, dict) else None
    sequence = timeline.get("sequence")
    if not isinstance(sequence, dict):
        sequence = project.get("sequence") if isinstance(project, dict) else canvas
    args = {
        "timeline_path": str(timeline_path),
        "output_path": str(out),
        "work_dir": str(work),
        "project": project,
        "assets": assets,
        "tracks": tracks,
        "output_canvas": canvas,
        "sequence": sequence,
        "encoder": encoder,
    }
    if hwaccel:
        args["hwaccel"] = hwaccel
    return args


def maybe_validate(ctx, payload: dict) -> None:
    try:
        from ve_tools.timeline import validate_timeline_data
    except ImportError:
        return
    try:
        _clips, issues = validate_timeline_data(payload, ctx)
    except TypeError:
        try:
            report = validate_timeline_data(payload)
        except Exception as exc:
            print(
                json.dumps({"validate_timeline_data_error": str(exc)}, ensure_ascii=False, default=str),
                file=sys.stderr,
            )
            return
        print(json.dumps({"validate_timeline_data": report}, ensure_ascii=False, default=str))
        return
    except Exception as exc:
        print(
            json.dumps({"validate_timeline_data_error": str(exc)}, ensure_ascii=False, default=str),
            file=sys.stderr,
        )
        return
    print(json.dumps({"validate_timeline_data": {"issues": issues}}, ensure_ascii=False, default=str))


def result_failed(result) -> bool:
    text = str(getattr(result, "text", "") or "")
    stripped = text.lstrip()
    if stripped.startswith("[ERROR]") or "timeline validation fail" in stripped.lower():
        return True
    data = getattr(result, "data", None)
    if isinstance(data, dict):
        if str(data.get("status") or "").lower() == "fail":
            return True
        issues = data.get("issues")
        if isinstance(issues, list) and any(
            isinstance(item, dict) and item.get("severity") == "error" for item in issues
        ):
            return True
    return False


def main() -> int:
    args = parse_args()
    accel_error = check_accel_args(args.encoder, args.hwaccel)
    if accel_error:
        print(f"[ERROR] {accel_error}", file=sys.stderr)
        return 2
    plugin_root = Path(os.environ.get("VE_PLUGIN_ROOT", REPO_ROOT / "work" / "video-agent-kit-plugin"))
    sys.path.insert(0, str(plugin_root / "mcp"))
    try:
        from ve_tools.render import render_preview
        from ve_tools.run_context import RunContext
    except ImportError as exc:
        print(
            f"[ERROR] não achei o motor em {plugin_root} (mcp/ve_tools/render.py). "
            f"Execute node scripts/setup.mjs para instalar o motor incluído. ({exc})",
            file=sys.stderr,
        )
        return 1

    timeline_path = Path(args.timeline).resolve()
    out_path = Path(args.out).resolve()
    work_path = Path(args.work).resolve()
    try:
        timeline = load_timeline(timeline_path)
    except Exception as exc:
        print(f"[ERROR] não li a timeline em {timeline_path}: {exc}", file=sys.stderr)
        return 2

    payload = preview_args(
        timeline,
        timeline_path,
        out_path,
        work_path,
        encoder=args.encoder,
        hwaccel=args.hwaccel,
    )
    ctx = RunContext(session_kind="cli")
    maybe_validate(ctx, timeline)

    try:
        result = render_preview(payload, ctx)
    except Exception:
        print("[ERROR] render_preview levantou exceção", file=sys.stderr)
        traceback.print_exc()
        return 2

    emit(result)
    return 2 if result_failed(result) else 0


if __name__ == "__main__":
    raise SystemExit(main())
