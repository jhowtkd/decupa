# ICE3-03 — Doctor cobrir todos os provedores de análise

> Base: `661d8c1`. TDD. Sem dependências novas. pt-BR. NÃO commitar; deixar diff dirty no worktree.

## Problema

`runDoctor` exige só `ZAI_API_KEY` e emite ERR mesmo quando `GEMINI_API_KEY`, `MINIMAX_API_KEY` ou `DECUPA_API_KEY` estão configuradas — mas `resolveProvider` aceita as 4. O SKILL manda parar no ERR, então o onboarding trava à toa para quem usa outro provedor.

Evidência: `apps/cli/src/doctor.ts:78-83` vs `packages/triage/src/provider.ts:42-66`. Teste fixado em `apps/cli/src/doctor.test.ts:57-61` precisa ser atualizado (comportamento antigo era o bug).

## Escopo permitido

- PODE tocar: `apps/cli/src/doctor.ts`, `apps/cli/src/doctor.test.ts`.
- NÃO tocar: qualquer outro arquivo. Escopo mínimo = chaves de env (credential armazenada `.decupa/` exige `--project`: fora do escopo, só mencionar no `fix`).

## Mudança

Substituir a linha `ZAI_API_KEY` por uma linha `chave de análise` que:

- OK quando QUALQUER UMA de `ZAI_API_KEY`, `GEMINI_API_KEY`, `MINIMAX_API_KEY`, `DECUPA_API_KEY` estiver setada; `detail` nomeia o provedor resolvido (reutilizar `resolveProvider(undefined, env)` de `@decupa/triage` — checar importabilidade; se o import cruzar pacotes de forma nova, replicar a ordem de precedência com comentário citando `provider.ts`).
- ERR caso contrário, com `fix` listando as 4 variáveis + `configure_provider`.

Manter a linha `ZAI_BASE_URL` como está.

## Testes (TDD)

Atualizar/adicionar em `doctor.test.ts` (puro, sem I/O além dos fakes existentes):

1. Atualizar `sem ZAI_API_KEY, nomeia a variável` → `sem nenhuma chave, lista as 4 variáveis` (env vazio → ERR citando as 4).
2. `com GEMINI_API_KEY, chave de análise passa` (env só com Gemini → OK, detail menciona gemini).
3. `precedência segue o resolver` (env com ZAI+Gemini → detail menciona zai).

## Verificação

```bash
WT=/tmp/decupa-wt-03
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-03#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-03.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-03.mjs apps/cli/src/doctor.test.ts packages/triage/src/provider.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Critério de sucesso

- Testes novos/atualizados falham antes, passam depois. Typecheck passa. Só os 2 arquivos no diff.
