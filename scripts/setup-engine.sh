#!/usr/bin/env bash
# Instala o motor de condense no estado exato que o Decupa exige: clone no
# commit pinado, com o patch de léxico PT-BR aplicado.
#
# O patch não está upstream. Sem ele o motor lê o material como inglês: o ponto
# final deixa de fechar frase (quase toda unidade vira "frase inacabada", a
# escolha de retake vira ruído) e "né"/"tipo"/"tá" deixam de ser soft filler.
# Rodar duas vezes não duplica nem falha.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${VE_PLUGIN_ROOT:-$REPO_ROOT/work/video-agent-kit-plugin}"
REMOTE="https://github.com/jhowtkd/video-agent-kit-plugin.git"
PINNED="d9fe30076c00ce2968d570622dd22ba068337568"
PATCH="$REPO_ROOT/scripts/engine/pt-br-lexicon.patch"

if [ ! -d "$ENGINE/.git" ]; then
  echo "clonando o motor em $ENGINE"
  git clone "$REMOTE" "$ENGINE"
fi

# --force só é seguro porque o patch é reaplicado logo abaixo; é o que torna o
# script idempotente mesmo com o working tree sujo da execução anterior.
if [ "$(git -C "$ENGINE" rev-parse HEAD)" != "$PINNED" ]; then
  git -C "$ENGINE" fetch --quiet origin
  git -C "$ENGINE" checkout --quiet --force "$PINNED"
fi

if git -C "$ENGINE" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "patch PT-BR já aplicado"
else
  git -C "$ENGINE" apply "$PATCH"
  echo "patch PT-BR aplicado"
fi

echo "motor pronto em $ENGINE ($PINNED)"
