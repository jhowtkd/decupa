# ICE3-08 — `global_start_time` inteiro e `timelineFrameRate` legível no OTIO

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

Em timeline 30000/1001, `global_start_time.value = fps * 3600 = 107892.107…` (não-inteiro) e `metadata.Resolve.timelineFrameRate = "29.97002997002997"` (14 decimais). `RationalTime` fracionário na origem pode deslocar todos os timecodes em 1 frame conforme o arredondamento do importador; a string de metadata dificilmente casa com enums do Resolve. Reproduzido localmente.

Evidência: `apps/cli/src/app/assembly/otio.ts:137` e `:108-111`. Teste fixado em `apps/cli/src/app/assembly/otio.test.ts:74` (`expect(...).toBe(fps * 3600)`) consagra o float — atualizar justificadamente.

## Escopo permitido

- PODE tocar: `apps/cli/src/app/assembly/otio.ts`, `apps/cli/src/app/assembly/otio.test.ts`.
- NÃO tocar: qualquer outro arquivo. NÃO mudar `rate` (continua o float exato `num/den` — a matemática de frames depende dele), NÃO mudar `start_time`/`duration` dos clipes.

## Mudança

- `global_start_time`: `time(Math.round(fps * 3600), fps)` — origem em frame inteiro (1h), mesma rate.
- `metadata.Resolve.timelineFrameRate` e `davinciImportSettings().timelineFrameRate`: string curta e estável — usar `String(Math.round(fps * 100) / 100)` (ex.: `"29.97"`)? Cuidado: `davinciImportSettings` também alimenta `procedure` com `num/den` exato (manter). Só a string de metadata muda. Se algum teste fixar `"29.97002997002997"`, atualizar com justificativa.
- `available_range`/`source_range`: intocados.

## Testes (TDD)

Em `otio.test.ts`:

1. Atualizar o teste fracionário: `global_start_time.value` inteiro (`Number.isInteger`) igual a `Math.round(fps*3600)`; `rate` continua `fps` exato (não `29.97`).
2. `metadata Resolve usa frame rate legível` — timeline 30000/1001 → `timelineFrameRate === "29.97"`; timeline 25 → `"25"`.
3. Paridade inteiro: timeline 25 inalterada (`108000`? `25*3600=90000` — checar valor atual no teste `:22`).

## Verificação

```bash
WT=/tmp/decupa-wt-08
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-08#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-08.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-08.mjs apps/cli/src/app/assembly/otio.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Novos asserts falham antes, passam depois. Typecheck passa. Só os 2 arquivos no diff. Validação de importação real no DaVinci permanece pendência externa (não abrir o Resolve).
