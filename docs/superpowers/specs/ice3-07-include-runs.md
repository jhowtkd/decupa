# ICE3-07 — `include` cria um take por run contíguo

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

`applyInclude` calcula `start = min(...)` / `end = max(...)` sobre TODAS as palavras selecionadas. Seleção não-contígua (possível via seleção geométrica em faixa estreita — `texto.js` seleciona por interseção de retângulo — ou via API) cria um take único que inclui em silêncio a fala NÃO selecionada entre os extremos.

Evidência: `apps/cli/src/app/assembly/words.ts:314-352`, esp. `:338-339`. Contraste: `remove`/`restore` já agrupam por runs contíguos (`wordIntervalsInTake`, `:153-207`).

## Escopo permitido

- PODE tocar: `apps/cli/src/app/assembly/words.ts` (função `applyInclude` apenas), `apps/cli/src/app/assembly/words.test.ts` (append no final).
- NÃO tocar: qualquer outro arquivo. NÃO mudar `wordIntervalsInTake`, `wordCutInterval` ou outras ações.

## Mudança

Em `applyInclude`, agrupar as palavras selecionadas por contiguidade no catálogo ordenado (mesmo critério de `wordIntervalsInTake`: índices consecutivos em `ordered`) e criar UM take por grupo, cada um com `[min,max]` do próprio grupo. Ordenar takes por start. Mint de ids sem colisão (reutilizar o loop `taken` existente, estendido para N takes).

Checar a rejeição "trecho já está na montagem": hoje testa cada intervalo contra `retained`; com grupos, testar cada intervalo do mesmo jeito (manter semântica; se QUALQUER palavra já estiver retida, erro como hoje — não incluir parcialmente).

## Testes (TDD, append em `words.test.ts`)

Usar o `project()` helper existente (w1..w4 contíguas no catálogo presumivelmente — checar o fixture do arquivo):

1. `include de palavras não-contíguas cria um take por run` — `wordIds: [w1, w3]` (pulando w2) → 2 takes; nenhum take cobre w2 (verificar `retainedRanges` de cada take).
2. `include contíguo segue criando take único` — `[w1, w2]` → 1 take (paridade).
3. `include rejeita se qualquer palavra já retida` — paridade com teste existente `:159-171` (não duplicar se já coberto; checar).

## Verificação

```bash
WT=/tmp/decupa-wt-07
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-07#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-07.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-07.mjs apps/cli/src/app/assembly/words.test.ts apps/cli/src/app/assembly/revisions.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Teste novo falha antes (take único cobrindo w2), passa depois. Demais testes do arquivo verdes. Typecheck passa. Só os 2 arquivos no diff.
