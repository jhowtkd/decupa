# ICE3-02 — Clampar cauda sub-frame no OTIO do `limpar`

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

No export OTIO do `limpar`, `durationFrames = max(1, round((end-start)*fps))` força 1 frame. Uma cauda retida de ~1 ms terminando no EOF passa na checagem float (`clip.end <= duration`) mas estoura `validateAssembly` ("ultrapassa a fonte") → export 500 de um corte legítimo e aprovado. Reproduzido: `start=9.999, end=10.0, fps=30` → throw.

Evidência: `apps/cli/src/app/server.ts:392-393` (construção dos clipes) + `apps/cli/src/app/assembly/validate.ts:145-153` (`assertClipFits`).

## Escopo permitido

- PODE tocar: `apps/cli/src/app/server.ts` (bloco `kind === "otio"` apenas, ~linhas 371-440), e testes em UM arquivo novo `apps/cli/src/app/server-otio-tail.test.ts` (unitário, sem `listen`).
- NÃO tocar: qualquer outro arquivo. NÃO mudar `validate.ts`, `otio.ts`, nem o teste fixado `server.test.ts:485` (recusa de clipe além da duração deve continuar passando).

## Mudança

Ao construir `videoClips` no bloco OTIO, clampar `durationFrames` para caber na fonte:

```ts
const maxFrames = Math.max(0, Math.floor((durationSeconds - clip.start) * fps));
const durationFrames = Math.min(Math.max(1, Math.round((clip.end - clip.start) * fps)), maxFrames);
```

Se `maxFrames === 0` (cauda 100% sub-frame no EOF), descartar o clipe em vez de emitir 1 frame inválido. Extrair para função pura `otioClipsForPlan(clips, fps, durationSeconds)` dentro de `server.ts` e exportá-la para teste unitário (ou testar via `buildOtio` montando o assembly equivalente — preferir a função pura).

## Testes (TDD)

Novo `server-otio-tail.test.ts` (sem servidor; importar a função pura):

1. `cauda de 1ms no EOF não gera clipe inválido` — `[{start: 9.999, end: 10.0}]`, fps 30, dur 10 → saída vazia ou clipe que passa em `validateAssembly`.
2. `clipe normal preservado` — `[{start: 1, end: 2}]` → 30 frames.
3. `clipe além da duração continua recusado` — `[{start: 9.9, end: 10.5}]` → erro "ultrapassa a fonte" (paridade com `server.test.ts:485`).

## Verificação

```bash
WT=/tmp/decupa-wt-02
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-02#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-02.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-02.mjs apps/cli/src/app/server-otio-tail.test.ts apps/cli/src/app/edl.test.ts apps/cli/src/app/assembly/otio.test.ts apps/cli/src/app/assembly/validate.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Testes novos falham antes, passam depois. Typecheck passa. `git diff --stat` + untracked mostram só `server.ts` e o novo teste.
