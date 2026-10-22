# Evidência — linha de base dos testes antes do Decupa Studio

Data: 22/10/2026. Commit medido: **`2b7ef06`** (`main` intocado, antes de qualquer mudança do PR 1 da pilha “Decupa Studio”). Ramo `studio/pr01-base-alternancia`, worktree limpo, `pnpm install --frozen-lockfile` recém-feito. Nenhum segredo neste arquivo; a suíte roda com as chaves zeradas por `vitest.config.ts`.

Ambiente: Linux 6.8.0 x86_64 · Node v24.21.0 · pnpm 10.32.1.

## Resultado

| Comando | Resultado | Contagem |
|---|---|---|
| `pnpm test` (`vitest run`) | **exit 1** — 1 falha intermitente (abaixo) | Arquivos: 348 passaram, 1 falhou, 2 pulados (351). Testes: 2887 passaram, 1 falhou, 5 pulados (2893). 117,6 s |
| `pnpm typecheck` (`tsc --noEmit`) | **PASSOU**, exit 0 | — |
| `pnpm lint` (`oxlint . --deny-warnings`) | **PASSOU**, exit 0 | — |
| `pnpm smoke` (`scripts/smoke-strip-types.mjs`) | **PASSOU**, exit 0 | `index.ts`, `triage.ts` e `app/server.ts` importam sob `--experimental-strip-types` |

## Falha pré-existente

`apps/cli/src/app/media-admission.test.ts` › *não admite sobre-reserva quando Drive reinicia e trunca parcial durante stat*

```text
Error: ENOENT: no such file or directory, open '<tmp>/media-admission-drive-restart-race-…/.tmp/00000000-0000-4000-8000-000000000601/data'
 ❯ apps/cli/src/app/media-admission.test.ts:665:72
Caused by: Error: Matcher did not succeed in time.
```

O `expect.poll` da linha 665 espera o parcial do Drive reaparecer e estoura o prazo quando a suíte inteira disputa a máquina. Rodando só o arquivo, passou nas três tentativas (22/22 cada). É intermitência de carga em código que o redesign não toca; não é regressão. Os PRs da pilha comparam contra esta tabela: essa falha, se aparecer, não conta como nova.
