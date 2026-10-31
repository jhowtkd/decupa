#!/usr/bin/env bash
# Só diagnóstico: cada modo roda o teste instrumentado e resume o rastreio.
set -u
T=apps/cli/src/app/assembly/media-cache-metric.additional.test.ts
uname -a
echo "nucleos: $(getconf _NPROCESSORS_ONLN)"
lote() {
  mode=$1; load=$2; n=$3; out=/tmp/tr-$mode.jsonl; : > "$out"
  if [ "$load" = 1 ]; then for i in 1 2 3 4 5 6 7 8; do yes >/dev/null 2>&1 & done; fi
  failed=0
  for i in $(seq 1 "$n"); do
    DIAG_MODE=$mode DIAG_TRACE=$out pnpm exec vitest run "$T" -t "concurrent proxy follower" --reporter=dot >/tmp/m.log 2>&1 || failed=$((failed+1))
  done
  echo "=== modo=$mode carga=$load: $failed de $n lotes com falha; yes vivos=$(pgrep -x yes | wc -l | tr -d ' '); $(uptime)"
  pkill -x yes || true
  python3 .github/diag/sum.py "$out"
}
lote natural 1 3
lote late 0 2
lote early 1 3
