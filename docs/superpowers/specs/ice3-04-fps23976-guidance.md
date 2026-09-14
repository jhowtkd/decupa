# ICE3-04 — Erro 23.976 no `limpar` aponta a saída OTIO

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

Export EDL a 23.976 fps morre em `probeFps` com mensagem pré-OTIO ("Exporte MP4, ou converta a fonte para fps inteiro") — o usuário nunca descobre que `kind: "otio"` suporta qualquer taxa racional. `buildEdl` já orienta para OTIO, mas `probeFps` roda antes e sua mensagem prevalece.

Evidência: `apps/cli/src/app/pipeline.ts:434-442` vs `apps/cli/src/app/edl.ts:60-65`. Testes fixados: `pipeline.test.ts:227-230` (espera throw com /29.97/), `edl.test.ts:78`.

## Escopo permitido

- PODE tocar: `apps/cli/src/app/pipeline.ts` (função `probeFps` apenas), `apps/cli/src/app/pipeline.test.ts` (append de testes no final).
- NÃO tocar: qualquer outro arquivo. NÃO implementar timecode 23.976 (exige validação no DaVinci — fora do escopo).

## Mudança

Em `probeFps`, quando o fps é fracionário não-suportado pelo EDL, lançar erro que nomeia a saída OTIO:

```ts
throw new Error(
  `o vídeo tem ${fps.toFixed(2)} fps, e o EDL só gera non-drop-frame com fps inteiro ou 29,97 drop-frame. ` +
  `Para este fps, exporte OTIO (kind "otio"), MP4, ou converta a fonte para fps inteiro antes.`,
);
```

Manter o comportamento (throw) e o caminho 29.97/drop-frame intactos. Manter `/29\.97/` casável? O teste existente espera `/29\.97/` para entrada 30000/1001 SEM `allowDropFrame` — a nova mensagem deve continuar contendo "29,97" ou "29.97" para não quebrar o teste existente. Verificar e, se preciso, ajustar apenas o append (não reescrever testes existentes, salvo o mínimo para a nova mensagem — preferir mensagem que mantém os asserts antigos verdes).

## Testes (TDD, append no final de `pipeline.test.ts`)

1. `fracionário não-EDL sugere OTIO` — `probeFps` com `24000/1001` rejeita com mensagem contendo `otio` (case-insensitive).
2. `29.97 com allowDropFrame continua passando` — paridade (já coberto? se sim, não duplicar; checar antes).

## Verificação

```bash
WT=/tmp/decupa-wt-04
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-04#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-04.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-04.mjs apps/cli/src/app/pipeline.test.ts apps/cli/src/app/edl.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Teste novo falha antes, passa depois. Todos os testes existentes do arquivo continuam verdes. Typecheck passa. Só os 2 arquivos no diff.
