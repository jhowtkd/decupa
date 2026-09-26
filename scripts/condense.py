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
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = Path(os.environ.get("VE_PLUGIN_ROOT", REPO_ROOT / "work" / "video-agent-kit-plugin"))
sys.path.insert(0, str(PLUGIN_ROOT / "mcp"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from ve_tools.condense import condense_index, condense_plan, condense_qc, condense_render
    from ve_tools.run_context import RunContext
except ImportError as exc:
    print(
        f"[ERROR] não achei o motor em {PLUGIN_ROOT} (mcp/ve_tools/condense.py). "
        f"Execute node scripts/setup.mjs para instalar o motor incluído. ({exc})",
        file=sys.stderr,
    )
    raise SystemExit(1)


def _print_result(result) -> int:
    """Imprime e traduz falha do motor em código de saída.

    As funções do motor sinalizam erro DEVOLVENDO ToolResult(text="[ERROR] ...")
    em vez de levantar exceção. Sem esta checagem o wrapper sairia 0 num plano
    que falhou, e um `&&` no shell — ou uma sessão seguindo o SKILL.md em
    sequência — seguiria para o render em cima de um plano velho.
    """
    print(result.text)
    return 2 if result.text.lstrip().startswith("[ERROR]") else 0


def cmd_index(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    result = condense_index({
        "video_path": args.video,
        "transcript_path": args.transcript,
        "visual_survey": args.visual_survey,
    }, ctx)
    return _print_result(result)


def cmd_plan(args: argparse.Namespace) -> int:
    ctx = RunContext(session_kind="cli")
    plan_args: dict = {"video_path": args.video, "keep": args.keep}
    if args.drop_fillers:
        plan_args["drop_fillers"] = args.drop_fillers
    for flag, key in (
        ("max_gap", "max_gap"),
        ("lead_in", "lead_in"),
        ("lead_out", "lead_out"),
        ("min_clip", "min_clip"),
    ):
        value = getattr(args, flag)
        if value is not None:
            plan_args[key] = value
    result = condense_plan(plan_args, ctx)
    return _print_result(result)


def cmd_render(args: argparse.Namespace) -> int:
    # Corte duro concatena por cópia do vídeo (ver scripts/concat_copy.py).
    from ve_tools import condense as engine
    import concat_copy
    import segment_cut

    # Segmentos começando em zero (sem deriva) e em VideoToolbox quando a
    # origem é HEVC no macOS (ver scripts/segment_cut.py); a junção só copia o
    # vídeo se nenhum segmento precisou cair para libx264.
    segment_cut.install(engine, hard_join=args.join == "hard")
    concat_copy.install(engine, should_copy=lambda: not segment_cut.state["mixed"])
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
    p_index.add_argument("--no-visual-survey", dest="visual_survey", action="store_false",
                         help="pula cortes de cena, contact sheet e análise de movimento")
    p_index.set_defaults(func=cmd_index)

    p_plan = sub.add_parser("plan", help="transforma keep-list em pontos de corte")
    p_plan.add_argument("video")
    p_plan.add_argument("--keep", nargs="+", required=True, help='ex: u001-u003 u005-u022')
    p_plan.add_argument("--drop-fillers", choices=["hard", "aggressive"], default=None)
    # Ritmo. O default do motor (max_gap 0.45, lead_out 0.22) é pensado para
    # fala corrida; corte de Reels é bem mais seco. Ver o preset no SKILL.md.
    p_plan.add_argument("--max-gap", type=float, default=None,
                        help="teto de pausa interna, em segundos (motor: 0.45)")
    p_plan.add_argument("--lead-in", type=float, default=None,
                        help="folga antes de cada clipe (motor: 0.10)")
    p_plan.add_argument("--lead-out", type=float, default=None,
                        help="folga depois de cada clipe (motor: 0.22)")
    p_plan.add_argument("--min-clip", type=float, default=None,
                        help="duração mínima de clipe (motor: 0.60)")
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
