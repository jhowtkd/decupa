# ICE-2 — Índice para execução paralela

> Base: `codex/editor-texto-centrado` @ `403bcf8`.
> Cada plano é um worktree próprio. Depois do merge, auditar contra este índice.

**Não implementar daqui.** Abrir um worktree por plano e seguir só aquele arquivo.

## Como disparar (10 worktrees)

Na raiz do repo (`/Users/jhonatan/Repos/Video editor`):

```bash
BASE=$(git rev-parse HEAD)   # esperado: 403bcf8…
git worktree add -b ice2-01-asr-cauda           "../decupa-ice2-01" "$BASE"
git worktree add -b ice2-02-pending             "../decupa-ice2-02" "$BASE"
git worktree add -b ice2-03-playhead            "../decupa-ice2-03" "$BASE"
git worktree add -b ice2-04-otio-limpar         "../decupa-ice2-04" "$BASE"
git worktree add -b ice2-05-snap-persist        "../decupa-ice2-05" "$BASE"
git worktree add -b ice2-06-export-load         "../decupa-ice2-06" "$BASE"
git worktree add -b ice2-07-canvas-video        "../decupa-ice2-07" "$BASE"
git worktree add -b ice2-08-extract-seek        "../decupa-ice2-08" "$BASE"
git worktree add -b ice2-09-otio-rates          "../decupa-ice2-09" "$BASE"
git worktree add -b ice2-10-quadro-sliver       "../decupa-ice2-10" "$BASE"
```

Em cada worktree: `pnpm install --frozen-lockfile` se `node_modules` não estiver compartilhado; senão o `node_modules` da raiz serve (os worktrees são irmãos). Rodar o plano com executing-plans / um agente por worktree.

**Nunca** `git add -A`. **Nunca** commitar `.gitignore` / `.foglamp/`. **Nenhuma** dependência nova. **Nenhuma** chamada paga (Z.ai/GLM/WhisperX live).

## Donos de arquivo (isolamento)

| # | Plano | Arquivos que PODE tocar | Não tocar |
|---|---|---|---|
| 01 | [asr-cauda-duracao](2026-09-12-ice2-01-asr-cauda-duracao.md) | `analysis.ts`, `analysis.test.ts` | resto |
| 02 | [retomar-pending](2026-09-12-ice2-02-retomar-correcao-pending.md) | `routes.ts` (`publishCorrection`, `alignCorrectionJob`, handler `GET /project`), `routes.test.ts` | `applyCanvasFrom` (plano 07) |
| 03 | [playhead-palavra](2026-09-12-ice2-03-playhead-palavra.md) | `editor/montage.js`, `editor/montage.test.ts`, `editor/texto.js` | `texto.test.ts` só se precisar |
| 04 | [otio-limpar-identidade](2026-09-12-ice2-04-otio-limpar-identidade.md) | `server.ts` (bloco `kind === "otio"` + import `hashFile`), `server.test.ts` | assembly/otio.ts (plano 09) |
| 05 | [snap-persistivel](2026-09-12-ice2-05-snap-persistivel.md) | `store.ts` (`validateWord`), `store.test.ts`, `words.ts` (`wordIntervalsInTake`), `words.test.ts` | routes.ts |
| 06 | [export-loadproject](2026-09-12-ice2-06-export-loadproject.md) | `export.ts` (catch do `loadProject`), `export.test.ts` | resto |
| 07 | [canvas-primeiro-video](2026-09-12-ice2-07-canvas-primeiro-video.md) | `routes.ts` **somente** `applyCanvasFrom` + exportar a função, `routes.test.ts` (testes novos no final) | `publishCorrection` / GET (plano 02) |
| 08 | [extract-seek](2026-09-12-ice2-08-extract-audio-seek.md) | `packages/media/src/audio.ts`, `audio.test.ts` | resto |
| 09 | [otio-rates](2026-09-12-ice2-09-otio-available-range.md) | `assembly/otio.ts`, `otio.test.ts` | `server.ts` (plano 04) |
| 10 | [quadro-sliver](2026-09-12-ice2-10-quadro-sliver.md) | `scenes.ts` (`compileScenes` laço de takes), `scenes.test.ts` | resto |

Planos 02 e 07 editam o **mesmo arquivo** em hunks disjuntos. Se o merge conflitar: 07 só muda o `if` de `applyCanvasFrom`; 02 não toca essa função.

## Auditoria depois

Para cada worktree: `git log --oneline $BASE..HEAD`, `git diff $BASE`, `npx vitest run <arquivos do plano>`, `pnpm run typecheck`. Conferir que o dono de arquivo foi respeitado.
