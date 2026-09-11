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

## Tarefa 2 — palavras e migração v1→v2

Commit: (a registrar). Review próprio (não independente).
Requisitos cobertos: R-002, R-003 (parcial: invariantes de palavra e separação texto/mídia; correct/remove/restore são tarefa 3).

Implementado:
- `analysis.ts`: `wordsFromTranscript(source, raw)` — IDs posicionais `${sourceId}:${sha256}:w${índice}`, confiança preservada (null quando ausente), nenhum tempo estimado; intervalo inválido rejeita. `analyzeSource` lê `transcript.json` do cache após ingest (palavras prontas ou `wordsStatus: "missing"`); fonte sem áudio recebe palavras vazias prontas; cache antigo sem `words` rederiva do transcript válido sem nova ASR e sem reescrever arquivo na leitura. `adaptAnalysis` remapeia IDs/sourceId de palavras.
- `condense/prepare.ts`: `CondenseWord` com `id?`/`confidence?` opcionais; `toCondenseTranscript` propaga ambos. Leitores por chave (motor/condense.py) ignoram extras.
- `store.ts`: validação real de palavras, takes (`validateSpeechTake`), correções, preparação, cobertura, análises e projeto; `validateProject` aceita v1 (migra) e v2; migração com `included: true`, palavras vazias + missing, correções [], permissões false, preparação/previewArtifact null, cenas/montagem preservadas; `saveProject` grava backup exclusivo `project.v1.backup.json` antes da primeira gravação v2; leitura nunca escreve; `mergeProjectCommit` estendido (correções por união de id; permissões/preparação/artefato com mesma semântica anti-stale das aprovações).
- `types.ts`: `Word`, `SpeechTake`, `TextCorrection`, `StageState`, `Preparation`, `VisualCoverage`, `Project` v2, `LegacyProject`/`LegacyAnalysis` só-leitura/migração. `Scene` inalterada (takes persistem na tarefa 6, junto de compile/validate que os consomem).
- Mecânicos para typecheck: `fixture.ts`/`routes.ts` (`included`, `blankProject` v2), `validate.ts` (`included`, padrão true), literais de `scenes/revisions/export/store.test.ts`.

Ajuste documentado vs plano: a conversão speechIds→takes de cenas persistidas move para a tarefa 6. Evidência: `compileScenes`/`validateProposal` (`scenes.ts`) e propostas do LLM operam sobre `speechIds` hoje; converter takes em store sem trocar o compilador criaria seleção dupla (speechIds + takes) com risco de divergência. O resultado aprovado não muda: migração preserva cenas/montagem para consulta, sem inferir tempos por texto, e a tarefa 6 converte com catálogo + validação.

Testes: `analysis.test.ts` +5, `store.test.ts` +5, `prepare.test.ts` ~2 (1 atualizado). Comando: `vitest run analysis/store/prepare/transcribe` → 35 passed. Suíte ampla (assembly+condense+transcript): 90 passed, 11 failed — todos `routes.test.ts` EPERM de sandbox (mesma causa de G0). `pnpm typecheck` exit 0, `git diff --check` limpo.
Achados: nenhum P0/P1. G0-F01 segue aberto (recheck HTTP fora do sandbox).
Próxima ação: tarefa 3 (words.ts, edição, alinhamento, undo).

## Gates seguintes

(G1–G7 a preencher durante a execução.)
