#!/usr/bin/env bash
# Só diagnóstico: cada modo roda o teste instrumentado e resume o rastreio.
set -u
T=apps/cli/src/app/assembly/media-cache-metric.additional.test.ts
uname -a
echo "nucleos: $(getconf _NPROCESSORS_ONLN); timeout=$(command -v timeout || echo ausente) gtimeout=$(command -v gtimeout || echo ausente)"
rodar() {
  mode=$1; rotulo=$2; n=$3; out=/tmp/tr-$rotulo.jsonl; : > "$out"
  failed=0
  for i in $(seq 1 "$n"); do
    DIAG_MODE=$mode DIAG_TRACE=$out pnpm exec vitest run "$T" -t "concurrent proxy follower" --reporter=dot >/tmp/m.log 2>&1 || failed=$((failed+1))
  done
  echo "=== $rotulo: $failed de $n lotes com falha; yes vivos=$(pgrep -x yes | wc -l | tr -d ' '); $(uptime)"
  pkill -x yes || true
  python3 .github/diag/sum.py "$out"
}
rodar natural natural-sem-carga 8
for i in 1 2 3 4 5 6 7 8; do (timeout 240 yes >/dev/null 2>&1 || gtimeout 240 yes >/dev/null 2>&1) & done
sleep 2; echo "yes vivos apos metodo original: $(pgrep -x yes | wc -l | tr -d ' ')"
rodar natural natural-metodo-original 8
for i in 1 2 3 4 5 6 7 8; do yes >/dev/null 2>&1 & done
rodar natural natural-carga-continua 3
rodar late late-sem-carga 2
for i in 1 2 3 4 5 6 7 8; do yes >/dev/null 2>&1 & done
rodar early early-carga-continua 3
