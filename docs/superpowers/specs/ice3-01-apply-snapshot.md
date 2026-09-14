# ICE3-01 — Snapshot de histórico no `/apply` (undo de proposta)

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

`POST /project/apply` substitui `scenes` via `applyProposal` sem fotografar o estado editorial. Proposta aplicada pode descartar takes/cortes/proteções sem possibilidade de undo — só retrabalho manual (e nova proposta paga). `writeHistorySnapshot` só é chamado em `/edit` e `/undo`.

Evidência: `apps/cli/src/app/assembly/routes.ts:948-959` (sem snapshot) vs `routes.ts:990` (com snapshot).

## Escopo permitido

- PODE tocar: `apps/cli/src/app/assembly/routes.ts` (handler `/apply` apenas), `apps/cli/src/app/assembly/routes.test.ts` (testes novos append no final).
- NÃO tocar: qualquer outro arquivo.

## Mudança

No handler `/apply`, antes de `mutate`, fotografar o projeto carregado, reutilizando o padrão de `/edit`:

```ts
const loaded = await loadProject(dir);
if (loaded.revision !== baseRevision) throw new HttpError(409, ...);
await writeHistorySnapshot(dir, loaded);
```

`writeHistorySnapshot` já está importado em `routes.ts`. Não mudar mais nada no handler.

## Testes (TDD: falhar primeiro)

Append no final de `routes.test.ts` (NÃO usar `listen`; usar helpers de runtime/call direto como os testes de `publishCorrection`, pois o sandbox bloqueia bind de socket):

1. `apply fotografa o histórico: undo restaura takes/cortes anteriores` — projeto com cena+take com `removed`; aplica proposta que troca as cenas; lê snapshot `history/rev-<N>.json` e/ou desfaz via `applyHistorySnapshot`+`readHistorySnapshot` e espera takes/cortes originais.
2. `apply com proposta ausente retorna 409` sem quebrar o fluxo de undo seguinte.

## Verificação

```bash
WT=/tmp/decupa-wt-01
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-01#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-01.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-01.mjs apps/cli/src/app/assembly/routes.test.ts apps/cli/src/app/assembly/store.test.ts apps/cli/src/app/assembly/revisions.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Teste novo falha antes, passa depois. Typecheck passa. Nenhum teste existente alterado; `git diff --stat` mostra só os 2 arquivos.
