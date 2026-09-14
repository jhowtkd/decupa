# ICE3-09 — Retenção e poda de derivados (`rev-N`, `history`, `exports`)

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

Cada prévia cria `rev-<N>/reference.mp4` inteiro, cada edição um `history/rev-<N>.json`, cada export um `exports/<N>/` — sem nenhuma poda. Projetos longos esgotam disco em silêncio.

Evidência: `apps/cli/src/app/assembly/render.ts:117`, `apps/cli/src/app/assembly/store.ts:661-676`, `apps/cli/src/app/assembly/export.ts:153`. Atenção: `/project/output/<rev>/mp4` serve revisões antigas (`routes.ts:570-591`) — poda agressiva quebra playback de histórico.

## Escopo permitido

- PODE tocar: arquivo NOVO `apps/cli/src/app/assembly/retention.ts` + testes em arquivo NOVO `apps/cli/src/app/assembly/retention.test.ts`; chamadas mínimas em `render.ts` (após publicar prévia) e/ou `export.ts` (após publicar export). Preferir chamar em UM ponto só.
- NÃO tocar: `routes.ts` (pertence ao item 01), `store.ts`, testes existentes.

## Mudança

Novo `retention.ts` com `pruneProject(dir, keep: { revisions: number }): Promise<{ deleted: string[] }>`:

- Política: manter sempre (nunca deletar): a revisão ATUAL (`project.json`), revisões com diretório em `exports/` (entregas), `previewArtifact`/`previewRevision`/`finalApprovedRevision` referenciados; das demais `rev-*`, manter as `K` mais recentes (default `K=3`, parametrizável); `history/rev-*.json` acompanha a mesma regra (manter K + exportadas).
- Segurança: só deletar nomes casando exatamente `rev-<int>` / `rev-<int>.json` dentro dos diretórios esperados; nunca seguir symlink; nunca tocar `project.json`, `imports/`, `media/`, `analysis/`, `exports/`; best-effort com erro agregador (falha de um delete não aborta os outros; erro final em pt-BR listando).
- Chamada: ao final de `renderAssembly` (após `rename` publicar) e/ou `exportApproved` — escolher o ponto com acesso a `dir` + revisão; `renderAssembly` recebe `outDir=dir` e `valid.revision` — ideal. Best-effort: poda NÃO pode falhar o render (capturar e seguir; sem log poluído — ou `console.warn` único? preferir silencioso com retorno ignorado documentado).

## Testes (TDD, `retention.test.ts`, sem `listen`, tmpdir real)

1. `poda rev-N antigos mantendo K+exportadas` — fixture com `rev-1..5` + `exports/2` + `project.json` rev 5 → após `pruneProject(dir, {revisions: 2})`, existem `rev-4, rev-5` (+2 por exportada), sumiram `rev-1, rev-3`.
2. `nunca deleta revisão atual nem entrega` — `rev-5` (atual) e `rev-2` (exportada) sobrevivem mesmo com K=0.
3. `ignora nomes fora do padrão` — `rev-abc/`, `reference.mp4` solto, symlink → intactos.
4. `history acompanha` — `history/rev-1.json` podado junto, `history/rev-5.json` mantido.

## Verificação

```bash
WT=/tmp/decupa-wt-09
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-09#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-09.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-09.mjs apps/cli/src/app/assembly/retention.test.ts apps/cli/src/app/assembly/render.test.ts apps/cli/src/app/assembly/export.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Testes novos falham antes (função inexistente), passam depois. `render.test.ts`/`export.test.ts` existentes verdes sem modificação. Typecheck passa.

## Aprovação de produto

Default `K=3` assumido; registrar no relatório se o mantenedor preferir outro valor — é uma constante.
