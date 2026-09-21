#!/usr/bin/env python3
"""Mede recursos de um comando de render de forma segura (stdlib only).

Lança somente o processo/grupo pedido, amostra RSS+CPU da árvore descendente
via `ps` a cada 500ms e interrompe pelo teto do ensaio. Uso:

    python3 scripts/render-resource-proof.py [--out saida.json] -- CMD [ARGS...]

Escreve JSON com wall_seconds, peak_rss_bytes, cpu_percent_samples,
exit_code, stopped_for_memory e measurement_error (null quando a medição
funcionou), além de swap antes/depois (registro, sem interpretação). Se o
ps falha, o ensaio é interrompido e registrado — nunca apresentado como
consumo zero. Sem credenciais e sem chamadas externas.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time

SAMPLE_INTERVAL = 0.5
KILL_GRACE_SECONDS = 2.0
FOUR_GIB = 4 * 1024**3


class MeasurementError(RuntimeError):
    """ps indisponível ou ilegível: o ensaio segue sem proteção efetiva."""


def physical_memory() -> int:
    try:
        out = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
        return int(out.stdout.strip())
    except Exception:
        pass
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    raise RuntimeError("não consegui ler a RAM física (sysctl hw.memsize)")


def swap_usage() -> str:
    try:
        out = subprocess.run(
            ["sysctl", "vm.swapusage"],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
        return (out.stdout or out.stderr).strip()
    except Exception as exc:
        return f"indisponível: {exc}"


def _ps_table() -> tuple[dict[int, list[int]], dict[int, str]]:
    """(filhos por ppid, stat por pid). Falha de ps devolve vazios: quem
    mede trata como erro fatal; quem encerra cumpre o orçamento cego."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,stat="],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
    except Exception:
        return {}, {}
    if out.returncode != 0:
        return {}, {}
    children: dict[int, list[int]] = {}
    states: dict[int, str] = {}
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)
        states[pid] = parts[2]
    return children, states


def _descendants(root_pid: int, children: dict[int, list[int]]) -> set[int]:
    """PID raiz + descendentes via ppid (inclui sessões próprias)."""
    found: set[int] = set()
    stack = [root_pid]
    while stack:
        pid = stack.pop()
        if pid in found:
            continue
        found.add(pid)
        stack.extend(children.get(pid, []))
    return found


def tree_pids(root_pid: int) -> set[int]:
    """PID raiz + descendentes via ppid (inclui sessões próprias)."""
    children, _states = _ps_table()
    return _descendants(root_pid, children)


def _ps_alive(pid: int, states: dict[int, str]) -> bool:
    state = states.get(pid)
    return state is not None and not state.startswith("Z")


def _sample_full(root_pid: int) -> tuple[int, float, set[int]]:
    """(RSS bytes, %CPU, pids da árvore). Falha de ps levanta
    MeasurementError: zero sem medição não é consumo zero."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,rss=,pcpu="],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
    except Exception as exc:
        raise MeasurementError(f"ps indisponível: {exc}") from exc
    if out.returncode != 0:
        detail = (out.stderr or "").strip().splitlines()
        raise MeasurementError(f"ps falhou (exit {out.returncode}): {detail[0][:200] if detail else 'sem stderr'}")
    children: dict[int, list[int]] = {}
    stats: dict[int, tuple[int, float]] = {}
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            pid, ppid, rss_kb = int(parts[0]), int(parts[1]), int(parts[2])
            pcpu = float(parts[3])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)
        stats[pid] = (rss_kb * 1024, pcpu)
    total_rss, total_cpu = 0, 0.0
    stack = [root_pid]
    seen = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        rss, cpu = stats.get(pid, (0, 0.0))
        total_rss += rss
        total_cpu += cpu
        stack.extend(children.get(pid, []))
    return total_rss, total_cpu, seen


def sample_tree(root_pid: int) -> tuple[int, float]:
    """Soma RSS (bytes) e %CPU do PID e descendentes via ppid."""
    total_rss, total_cpu, _ = _sample_full(root_pid)
    return total_rss, total_cpu


def _signal_tree(pids: set[int], sig: int) -> None:
    for pid in pids:
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def _tree_dead_ps(proc, pid: int, targets: set[int], states: dict[int, str]) -> bool:
    # Sem snapshot não se declara morte: cumpre o orçamento sinalizando.
    if not states:
        return False
    # O filho direto vira zumbi até wait(): para ele vale poll().
    if proc is not None:
        if proc.poll() is None and _ps_alive(pid, states):
            return False
    elif _ps_alive(pid, states):
        return False
    return not any(_ps_alive(t, states) for t in targets if t != pid)


def _stopped_or_dead(pid: int, states: dict[int, str]) -> bool:
    state = states.get(pid)
    return state is None or state.startswith("Z") or state.startswith("T")


def _signal_targets(known: set[int], states: dict[int, str], sig: int) -> None:
    # Cego (sem snapshot): sinaliza todos os conhecidos; mortos evaporam via
    # ProcessLookupError. Com snapshot: só os vivos, para não tocar pid
    # reutilizado nem zumbi.
    if states:
        _signal_tree({t for t in known if _ps_alive(t, states)}, sig)
    else:
        _signal_tree(set(known), sig)


def _signal_group(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def terminate_tree(pid: int, proc=None, known: set[int] | None = None) -> None:
    """Encerra a árvore inteira do ensaio, inclusive sessões próprias (ex.
    SpawnExecutor, que cria grupo novo). Primeiro aquieta tudo com SIGSTOP
    até nenhum pid novo aparecer — parado não forka, então o snapshot
    estabiliza; depois SIGTERM + SIGCONT, espera, e SIGKILL nos restantes
    (KILL pega parado sem CONT). O grupo do raiz cobre reparentados do
    grupo; os pids cobrem o resto. Nunca pkill global.
    ``known`` semeia o universo com os descendentes observados durante o
    acompanhamento: se ps falhar na hora de encerrar, o modo cego sinaliza
    a última árvore conhecida (+ grupo) em vez de mirar só o raiz. Risco
    residual do modo cego: reuso de PID na janela de poucos segundos; os
    alvos foram observados vivos há pouco, o que estreita a janela.
    O try/finally começa ANTES do primeiro SIGSTOP: qualquer interrupção no
    meio do quiesce retoma (SIGCONT) o universo conhecido, sem deixar
    processos parados para trás. Só paramos pids de `live`, então processos
    nunca observados jamais ficam congelados por nós."""
    live: set[int] = set(known) if known else set()
    try:
        stop_deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < stop_deadline:
            children, states = _ps_table()
            before = set(live)
            live |= _descendants(pid, children)
            _signal_targets(live, states, signal.SIGSTOP)
            if live == before and all(_stopped_or_dead(t, states) for t in live):
                break
            time.sleep(0.05)
        _signal_tree(live, signal.SIGTERM)
        _signal_group(pid, signal.SIGTERM)
        _signal_tree(live, signal.SIGCONT)
        _signal_group(pid, signal.SIGCONT)
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < deadline:
            children, states = _ps_table()
            live |= _descendants(pid, children)
            if _tree_dead_ps(proc, pid, live, states):
                return
            _signal_targets(live, states, signal.SIGTERM)
            time.sleep(0.05)
        for _ in range(20):
            children, states = _ps_table()
            live |= _descendants(pid, children)
            if _tree_dead_ps(proc, pid, live, states):
                return
            _signal_group(pid, signal.SIGKILL)
            _signal_targets(live, states, signal.SIGKILL)
            time.sleep(0.05)
    finally:
        # Nunca deixar para trás um processo parado que tocamos: retoma o
        # universo conhecido (único conjunto que paramos) e o grupo por
        # belt-and-braces — CONT em processo rodando é no-op.
        _signal_tree(live, signal.SIGCONT)
        _signal_group(pid, signal.SIGCONT)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="", help="arquivo JSON do resultado (default: stdout)")
    parser.add_argument(
        "--test-ceiling-bytes", type=int, default=0,
        help="teto reduzido, exclusivo para validar o script (default: min(4GiB, RAM/4))",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER, help="comando após --")
    args = parser.parse_args(argv)
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("informe o comando após --")
    return args


def _emit(args: argparse.Namespace, result: dict) -> None:
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)


def main() -> int:
    args = parse_args(sys.argv[1:])
    ceiling = args.test_ceiling_bytes or min(FOUR_GIB, physical_memory() // 4)
    swap_before = swap_usage()
    start = time.monotonic()
    # Pre-flight: sem medição não se inicia o comando. Encerrar depende do
    # mesmo ps; começar cego arriscaria deixar descendentes para trás.
    try:
        _sample_full(os.getpid())
    except MeasurementError as exc:
        _emit(args, {
            "command": args.command,
            "wall_seconds": round(time.monotonic() - start, 3),
            "peak_rss_bytes": 0,
            "cpu_percent_samples": [],
            "exit_code": None,
            "stopped_for_memory": False,
            "interrupted": False,
            "measurement_error": f"pre-flight: {exc}",
            "ceiling_bytes": ceiling,
            "physical_memory_bytes": physical_memory(),
            "swap_before": swap_before,
            "swap_after": swap_usage(),
        })
        return 0
    proc = subprocess.Popen(args.command, start_new_session=True)  # noqa: S603
    peak_rss = 0
    cpu_samples: list[float] = []
    stopped_for_memory = False
    interrupted = False
    measurement_error: str | None = None
    known: set[int] = {proc.pid}
    try:
        while proc.poll() is None:
            try:
                rss, cpu, pids = _sample_full(proc.pid)
            except MeasurementError as exc:
                measurement_error = str(exc)
                terminate_tree(proc.pid, proc, known)
                break
            known |= pids
            peak_rss = max(peak_rss, rss)
            cpu_samples.append(round(cpu, 2))
            if rss > ceiling:
                terminate_tree(proc.pid, proc, known)
                stopped_for_memory = True
                break
            time.sleep(SAMPLE_INTERVAL)
    except KeyboardInterrupt:
        interrupted = True
        terminate_tree(proc.pid, proc, known)
    proc.wait()
    wall = time.monotonic() - start
    _emit(args, {
        "command": args.command,
        "wall_seconds": round(wall, 3),
        "peak_rss_bytes": peak_rss,
        "cpu_percent_samples": cpu_samples,
        "exit_code": proc.returncode,
        "stopped_for_memory": stopped_for_memory,
        "interrupted": interrupted,
        "measurement_error": measurement_error,
        "ceiling_bytes": ceiling,
        "physical_memory_bytes": physical_memory(),
        "swap_before": swap_before,
        "swap_after": swap_usage(),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
