#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OTIO_PATH="${1:-}"

if [ -z "$OTIO_PATH" ]; then
  # Busca a timeline OTIO mais recente em work/assembly-proof
  LATEST_OTIO=$(ls -t "$REPO_ROOT"/work/assembly-proof/run-*/timeline.otio 2>/dev/null | head -n 1 || true)
  if [ -n "$LATEST_OTIO" ]; then
    OTIO_PATH="$LATEST_OTIO"
  fi
fi

if [ -z "$OTIO_PATH" ] || [ ! -f "$OTIO_PATH" ]; then
  echo "Nenhum arquivo timeline.otio encontrado."
  echo "Execute scripts/assembly-proof.ts antes ou informe o caminho:"
  echo "  $0 caminho/para/timeline.otio"
  exit 1
fi

echo "Validando importação no DaVinci Resolve para: $OTIO_PATH"
python3 "$REPO_ROOT/scripts/davinci-proof.py" "$OTIO_PATH"
