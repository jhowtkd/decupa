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
# ponytail: ps start times have one-second precision; PID reuse within that
# second remains a platform limitation. Blind signaling expires after 5s.
KNOWN_MAX_AGE = 5.0
Identity = tuple[str, float]
State = tuple[str, str]  # status, process start time (lstart)


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


def _ps_table() -> tuple[dict[int, list[int]], dict[int, State]]:
    """(filhos por ppid, stat por pid). Falha de ps devolve vazios: quem
    mede trata como erro fatal; quem encerra cumpre o orçamento cego."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,stat=,lstart="],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
    except Exception:
        return {}, {}
    if out.returncode != 0:
        return {}, {}
    children: dict[int, list[int]] = {}
    states: dict[int, State] = {}
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) != 8:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)
        states[pid] = (parts[2], " ".join(parts[3:]))
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


def _ps_alive(pid: int, states: dict[int, State]) -> bool:
    state = states.get(pid)
    return state is not None and not state[0].startswith("Z")


def _sample_full(root_pid: int, known: dict[int, Identity] | None = None) -> tuple[int, float, dict[int, Identity]]:
    """(RSS bytes, %CPU, pids da árvore). Falha de ps levanta
    MeasurementError: zero sem medição não é consumo zero."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,rss=,pcpu=,stat=,lstart="],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
    except Exception as exc:
        raise MeasurementError(f"ps indisponível: {exc}") from exc
    if out.returncode != 0:
        detail = (out.stderr or "").strip().splitlines()
        raise MeasurementError(f"ps falhou (exit {out.returncode}): {detail[0][:200] if detail else 'sem stderr'}")
    children: dict[int, list[int]] = {}
    stats: dict[int, tuple[int, float]] = {}
    states: dict[int, State] = {}
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) != 10:
            continue
        try:
            pid, ppid, rss_kb = int(parts[0]), int(parts[1]), int(parts[2])
            pcpu = float(parts[3])
        except ValueError:
            continue
        children.setdefault(ppid, []).append(pid)
        stats[pid] = (rss_kb * 1024, pcpu)
        states[pid] = (parts[4], " ".join(parts[5:]))
    if not stats:
        raise MeasurementError("ps não devolveu processos legíveis")
    tracked = _refresh_known(root_pid, children, states, known or {})
    return (sum(stats[p][0] for p in tracked),
            sum(stats[p][1] for p in tracked), tracked)


def _refresh_known(root_pid: int, children: dict[int, list[int]],
                   states: dict[int, State], known: dict[int, Identity]) -> dict[int, Identity]:
    now = time.monotonic()
    if not states:
        return {p: value for p, value in known.items() if now - value[1] <= KNOWN_MAX_AGE}
    # Retain reparented children only while their original identity is alive.
    result = {p: (birth, now) for p, (birth, _) in known.items()
              if _ps_alive(p, states) and states[p][1] == birth}
    # Never adopt a reused known PID, including the root, as a new descendant.
    roots = list(result)
    if root_pid not in known and root_pid in states:
        roots.append(root_pid)
    for root in roots:
        for pid in _descendants(root, children):
            if _ps_alive(pid, states) and (pid not in known or known[pid][0] == states[pid][1]):
                result[pid] = (states[pid][1], now)
    return result


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


def _tree_dead_ps(proc, pid: int, targets: set[int], states: dict[int, State]) -> bool:
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


def _stopped_or_dead(pid: int, states: dict[int, State]) -> bool:
    state = states.get(pid)
    return state is None or state[0].startswith("Z") or state[0].startswith("T")


def _signal_targets(known: dict[int, Identity], states: dict[int, State], sig: int) -> None:
    now = time.monotonic()
    targets = {p for p, (birth, _) in known.items()
               if _ps_alive(p, states) and states[p][1] == birth}
    if not states:
        # Never freeze identities we cannot currently verify.
        targets = set() if sig == signal.SIGSTOP else {
            p for p, (_, seen) in known.items() if now - seen <= KNOWN_MAX_AGE}
    _signal_tree(targets, sig)


def terminate_tree(pid: int, proc=None, known: dict[int, Identity] | None = None) -> None:
    """Stop/terminate observed identities, including children in other sessions.

    Fresh snapshots discard dead/reused PIDs. If ps fails, only identities
    seen within KNOWN_MAX_AGE are signaled. No unconditional group signals:
    a recycled process group must not target unrelated processes.
    """
    live = dict(known or {})
    try:
        stop_deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < stop_deadline:
            children, states = _ps_table()
            before = set(live)
            live = _refresh_known(pid, children, states, live)
            _signal_targets(live, states, signal.SIGSTOP)
            if set(live) == before and all(_stopped_or_dead(t, states) for t in live):
                break
            time.sleep(0.05)
        _signal_targets(live, states, signal.SIGTERM)
        _signal_targets(live, states, signal.SIGCONT)
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < deadline:
            children, states = _ps_table()
            live = _refresh_known(pid, children, states, live)
            if _tree_dead_ps(proc, pid, live, states):
                return
            _signal_targets(live, states, signal.SIGTERM)
            time.sleep(0.05)
        for _ in range(20):
            children, states = _ps_table()
            live = _refresh_known(pid, children, states, live)
            if _tree_dead_ps(proc, pid, live, states):
                return
            _signal_targets(live, states, signal.SIGKILL)
            time.sleep(0.05)
    finally:
        # Refresh before resuming; never resume a recycled identity.
        _, final_states = _ps_table()
        _signal_targets(live, final_states, signal.SIGCONT)
        # The direct child is owned by Popen (PID cannot recycle until reaped).
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=KILL_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


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
    known: dict[int, Identity] = {}
    try:
        while proc.poll() is None:
            try:
                rss, cpu, pids = _sample_full(proc.pid, known)
            except MeasurementError as exc:
                measurement_error = str(exc)
                terminate_tree(proc.pid, proc, known)
                break
            known = pids
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
