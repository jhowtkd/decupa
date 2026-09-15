#!/usr/bin/env bash
# Instala o motor de condense no estado exato que o Decupa exige: clone no
# commit pinado, com o patch de léxico PT-BR aplicado.
#
# O patch não está upstream. Sem ele o motor lê o material como inglês: o ponto
# final deixa de fechar frase (quase toda unidade vira "frase inacabada", a
# escolha de retake vira ruído) e "né"/"tipo"/"tá" deixam de ser soft filler.
#
# A lógica de instalação vive em scripts/setup.mjs (--engine-only), que é
# repetível e preserva um motor existente: em vez de checkout forçado, recusa
# e informa quando o clone está em outra revisão, modificado ou é inválido.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO_ROOT/scripts/setup.mjs" --engine-only
