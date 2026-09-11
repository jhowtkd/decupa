# Fluxo automático e edição textual — registro de evidências

Data de início: 2026-09-11. Executor: agente (Muse Code). Auto-review declarado onde indicado.

## Gate G0 — base e preservação

Estado: PASS com restrição de ambiente (12 testes HTTP não executáveis no sandbox; ver abaixo).
Commit/base de comparação: branch `codex/fluxo-automatico-edicao-textual` a partir de `3549f4e`; patch `patches/assembly-current-vs-8b0799b.patch` (SHA256 `860a99f7...051b`, confere com manifest/SHA256SUMS do pacote; 8/8 linhas OK).
Requisitos cobertos: R-001 (parcial: base consolidada; falta verificação HTTP), R-014 (contratos existentes preservados — typecheck verde).
Autor/revisor: autor agente; review próprio (não independente).

Verificações:
- Principal em `3549f4e` não continha `apps/cli/src/app/assembly/`; cópia `/private/tmp/decupa-review-e4e68443` em base `8b0799b` + alterações locais continha a implementação.
- `git apply --check` do patch sobre o principal: OK. Patch aplicado uma única vez na branch (não reaplicado sobre a cópia de teste).
- Pós-aplicação: 40/40 arquivos conferem com `source_postimage_sha256` do manifest; SHA do patch confere.
- Motor `work/video-agent-kit-plugin` em `d9fe30076c00ce2968d570622dd22ba068337568`; WIP `mcp/ve_tools/condense_lang.py` (M) preservado e intocado.
- Projeto Feira `/private/tmp/decupa-feira-e4e68443` não tocado. Originais em `/Users/jhonatan/Downloads/Videos Feira/` presentes (2 mp4).
- `pnpm typecheck`: exit 0. `git diff --check`: limpo.
- Baseline `vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts`: 55 passed, 12 failed — todos com `listen EPERM: operation not permitted 127.0.0.1` (routes.test.ts 11 + assembly-flow 1). Causa: sandbox desta sessão bloqueia bind em 127.0.0.1 (confirmado com probe mínimo `node http.listen(0, 127.0.0.1)` → EPERM; escalonamento `require_escalated` indisponível: approval prompts disabled). Não é regressão de código.
- Correção da tarefa 1 aplicada: `tests/assembly-flow.test.ts` agora asserta presença booleana das chaves (`expect(Boolean(...)).toBe(false)`); teste isolado `-t 'não usa chave live'` passa.

Comandos executados e códigos de saída:
- `(cd work/handoffs/decupa-execucao-2026-09-11 && shasum -a 256 -c SHA256SUMS)` → 8 OK, exit 0.
- `git apply --check <patch>` → OK, exit 0.
- `pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts` → 55 passed / 12 failed (EPERM ambiente), exit 0 (vitest) com falhas.
- `pnpm typecheck` → exit 0. `git diff --check` → limpo.
- Bug NTSC conhecido segue atribuído à tarefa 9 (não escondido como sucesso de render).

Evidência de navegador/áudio/render/DaVinci: nenhuma nesta etapa (fora do escopo de G0).
Achados abertos e rechecks: G0-F01 (P2): 12 testes HTTP não verificáveis neste sandbox; recheck = rodar fora do sandbox: `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/routes.test.ts tests/assembly-flow.test.ts`.
Próxima ação: tarefa 2 (palavras e migração v1→v2).

## Gates seguintes

(G1–G7 a preencher durante a execução.)
