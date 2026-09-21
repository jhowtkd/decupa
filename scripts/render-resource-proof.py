#!/usr/bin/env python3
"""Mede recursos de um comando de render de forma segura (stdlib only).

Lança somente o processo/grupo pedido, amostra RSS+CPU da árvore descendente
via `ps` a cada 500ms e interrompe pelo teto do ensaio. Uso:

    python3 scripts/render-resource-proof.py [--out saida.json] -- CMD [ARGS...]

Escreve JSON com wall_seconds, peak_rss_bytes, cpu_percent_samples,
exit_code e stopped_for_memory, além de swap antes/depois (registro, sem
interpretação). Sem credenciais e sem chamadas externas.
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


def sample_tree(root_pid: int) -> tuple[int, float]:
    """Soma RSS (bytes) e %CPU do PID e descendentes via ppid. Perdidos = 0."""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,rss=,pcpu="],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
    except Exception:
        return 0, 0.0
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
    return total_rss, total_cpu


def terminate_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return
    deadline = time.monotonic() + KILL_GRACE_SECONDS
    while time.monotonic() < deadline:
        try:
            os.killpg(pid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


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


def main() -> int:
    args = parse_args(sys.argv[1:])
    ceiling = args.test_ceiling_bytes or min(FOUR_GIB, physical_memory() // 4)
    swap_before = swap_usage()
    start = time.monotonic()
    proc = subprocess.Popen(args.command, start_new_session=True)  # noqa: S603
    peak_rss = 0
    cpu_samples: list[float] = []
    stopped_for_memory = False
    interrupted = False
    try:
        while proc.poll() is None:
            rss, cpu = sample_tree(proc.pid)
            peak_rss = max(peak_rss, rss)
            cpu_samples.append(round(cpu, 2))
            if rss > ceiling:
                terminate_group(proc.pid)
                stopped_for_memory = True
                break
            time.sleep(SAMPLE_INTERVAL)
    except KeyboardInterrupt:
        interrupted = True
        terminate_group(proc.pid)
    proc.wait()
    wall = time.monotonic() - start
    result = {
        "command": args.command,
        "wall_seconds": round(wall, 3),
        "peak_rss_bytes": peak_rss,
        "cpu_percent_samples": cpu_samples,
        "exit_code": proc.returncode,
        "stopped_for_memory": stopped_for_memory,
        "interrupted": interrupted,
        "ceiling_bytes": ceiling,
        "physical_memory_bytes": physical_memory(),
        "swap_before": swap_before,
        "swap_after": swap_usage(),
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
