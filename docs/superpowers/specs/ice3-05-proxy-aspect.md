# ICE3-05 — Proxies de triagem/visão sem distorção de aspecto

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

`runVisualIndex` usa `-vf fps=4,scale=540:960` e `makeTriageProxy` usa `-vf fps=1,scale=270:480` — ambos FORÇAM retrato, distorcendo fontes 16:9. Esses proxies alimentam o MediaPipe (`visual_index.py`, cujas flags entram em `takeScore` via `VISUAL_PENALTY` e decidem retakes automaticamente) e os frames do inspect pago (`resolveInspectVideoPath` prefere `visual-proxy.mp4`). O módulo de montagem já faz certo com `force_original_aspect_ratio=decrease`.

Evidência: `apps/cli/src/app/pipeline.ts:228` e `:292` vs `apps/cli/src/app/assembly/model.ts:93`.

## Escopo permitido

- PODE tocar: `apps/cli/src/app/pipeline.ts` (as duas strings `-vf` apenas) + UM arquivo novo `apps/cli/src/app/pipeline-proxy.test.ts`.
- NÃO tocar: qualquer outro arquivo (NÃO tocar `pipeline.test.ts` — pertence ao item 04; NÃO tocar `model.ts`).

## Mudança

- `runVisualIndex`: `-vf fps=4,scale='min(540,iw)':'min(960,ih)':force_original_aspect_ratio=decrease` — hmm, atenção: o sidecar MediaPipe pode esperar dimensões fixas? Checar `services/vision/visual_index.py` quanto a requisitos de dimensão antes de decidir. Se o sidecar exigir retrato, alternativa: `scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2` (letterbox sem distorcer). Escolher a variante que (a) não distorce e (b) mantém o contrato do sidecar; documentar a escolha no teste.
- `makeTriageProxy`: mesma lógica com teto 270×480.

## Testes (TDD, arquivo novo `pipeline-proxy.test.ts`)

Sem `listen`; usar `FakeExecutor` capturando args + (se ffmpeg disponível, teste de integração marcado) gerar clipe 16:9 e rodar `makeTriageProxy`/`runVisualIndex`-vf real via `SpawnExecutor`, com probe das dimensões de saída:

1. `proxy de triagem preserva 16:9` — args contêm `force_original_aspect_ratio` (ou pad) e NÃO `scale=270:480` cru.
2. `proxy visual preserva 16:9` — idem para 540:960.
3. (integração, pode pular se ffmpeg ausente) dimensões de saída conferidas via `probe`.

## Verificação

```bash
WT=/tmp/decupa-wt-05
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-05#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-05.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-05.mjs apps/cli/src/app/pipeline-proxy.test.ts apps/cli/src/app/pipeline.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Testes novos falham antes, passam depois. `pipeline.test.ts` existente 100% verde sem modificação. Typecheck passa.
