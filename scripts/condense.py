#!/usr/bin/env python3
"""Wrapper de CLI para as quatro funções de condense do motor vendorizado
(video-agent-kit-plugin, patch de léxico PT-BR aplicado localmente).

Chama as funções Python direto — sem transporte MCP, sem exigir mcp==1.0.0.
Isso é deliberado: o transporte MCP só importa quando o motor roda como
plugin de verdade dentro do Claude Code; para este script, que já É a camada
que uma sessão do Claude Code invoca via Bash, uma chamada de função direta é
mais simples e não fica presa ao pin de versão.

VE_PLUGIN_ROOT aponta para o clone do motor (default: work/video-agent-kit-plugin,
relativo à raiz deste repo). Mesma variável de ambiente que o motor já usa em
produção — ver .mcp.json no próprio repo do motor.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = Path(os.environ.get("VE_PLUGIN_ROOT", REPO_ROOT / "work" / "video-agent-kit-plugin"))
sys.path.insert(0, str(PLUGIN_ROOT / "mcp"))

try:
    from ve_tools.condense import condense_index, condense_plan, condense_qc, condense_render
    from ve_tools.run_context import RunContext
except ImportError as exc:
    print(
        f"[ERROR] não achei o motor em {PLUGIN_ROOT} (mcp/ve_tools/condense.py). "
        f"Clone jhowtkd/video-agent-kit-plugin lá, ou aponte VE_PLUGIN_ROOT. ({exc})",
        file=sys.stderr,
    )
    raise SystemExit(1)


def _print_result(result) -> int:
    print(result.text)
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_index({"video_path": args.video, "transcript_path": args.transcript}, ctx)
    return _print_result(result)


def cmd_plan(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    plan_args: dict = {"video_path": args.video, "keep": args.keep}
    if args.drop_fillers:
        plan_args["drop_fillers"] = args.drop_fillers
    result = condense_plan(plan_args, ctx)
    return _print_result(result)


def cmd_render(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_render(
        {"video_path": args.video, "output_path": args.out, "join": args.join}, ctx,
    )
    return _print_result(result)


def cmd_qc(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_qc({"video_path": args.video}, ctx)
    return _print_result(result)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="mede o vídeo — disfluência, pausas, orçamento de corte")
    p_index.add_argument("video")
    p_index.add_argument("transcript")
    p_index.set_defaults(func=cmd_index)

    p_plan = sub.add_parser("plan", help="transforma keep-list em pontos de corte")
    p_plan.add_argument("video")
    p_plan.add_argument("--keep", nargs="+", required=True, help='ex: u001-u003 u005-u022')
    p_plan.add_argument("--drop-fillers", choices=["hard", "aggressive"], default=None)
    p_plan.set_defaults(func=cmd_plan)

    p_render = sub.add_parser("render", help="corta e renderiza a partir do plano")
    p_render.add_argument("video")
    p_render.add_argument("out")
    p_render.set_defaults(func=cmd_render)
    p_render.add_argument("--join", choices=["hard", "dissolve"], default="hard")

    p_qc = sub.add_parser("qc", help="verifica o arquivo renderizado (áudio + salto visual)")
    p_qc.add_argument("video", help="o ARQUIVO RENDERIZADO, não o original")
    p_qc.set_defaults(func=cmd_qc)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
