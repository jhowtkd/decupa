#!/usr/bin/env bash
# Só diagnóstico: mede a mesma versão do teste, sem tocar em código de produção.
set -u
T=apps/cli/src/app/assembly/media-cache-metric.additional.test.ts
uname -a
echo "nucleos: $(getconf _NPROCESSORS_ONLN); timeout=$(command -v timeout || echo ausente) gtimeout=$(command -v gtimeout || echo ausente)"
rodar() {
  rotulo=$1; out=/tmp/ab-$rotulo.jsonl; : > "$out"
  failed=0
  for i in 1 2 3 4 5 6 7 8; do
    NO_COLOR=1 AB_TRACE=$out pnpm exec vitest run --exclude "_diag/**" "$T" -t "concurrent proxy follower" --reporter=dot >/tmp/m.log 2>&1 || { failed=$((failed+1)); grep -E "AssertionError|Error:" /tmp/m.log | sort | uniq -c | head -3; }
  done
  echo "=== $rotulo: $failed de 8 lotes com falha; yes vivos=$(pgrep -x yes | wc -l | tr -d ' '); $(uptime)"
  pkill -x yes || true
  python3 _diag/res.py "$out"
}
rodar sem-carga
for i in 1 2 3 4 5 6 7 8; do (timeout 240 yes >/dev/null 2>&1 || gtimeout 240 yes >/dev/null 2>&1) & done
sleep 2; echo "yes vivos no metodo original: $(pgrep -x yes | wc -l | tr -d ' ')"
rodar metodo-original
for i in 1 2 3 4 5 6 7 8; do yes >/dev/null 2>&1 & done
rodar carga-continua
