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

Commit: `89f3375`. Review próprio (não independente).
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

## Tarefa 3 — cortar, restaurar, corrigir e desfazer

Commit: `29d3586`. Review próprio (não independente).
Requisitos cobertos: R-003, R-004 (parcial: invariantes, proteção, undo persistente; caso Nilton Pinto segue para prova auditiva na tarefa 10).

Implementado:
- Novo `assembly/words.ts`: `retainedRanges`, `effectiveWords` (overlay só de `aligned`; pending preserva original), `applyTextEdit` puro (remove/restore/protect/unprotect/include/move/delete + correct overlay; bump de revisão e invalidação de aprovações; artefato anterior segue stale-por-revisão), `settleCorrection` (publica alinhamento/erro sem nova revisão e sem tocar takes), `parseEditAction` (união discriminada, 400 no HTTP), `snapWordCuts` (snapCut existente + trava nos vizinhos) e `wordCutInterval`.
- `services/speech/transcribe.py`: `--text-file` opcional (pula ASR, usa `whisperx.align` no recorte) e campo `unaligned` — palavras sem tempo registradas, nunca descartadas em silêncio (diagnóstico nº 3).
- `@decupa/transcript`: `alignText` (recorte, sidecar, origem somada uma vez, cobertura/ordem/tempos validados; falha nomeia o trecho sem vínculo), `validateAlignmentCoverage`, `unaligned?`/`cutStartMs?`/`cutEndMs?` opcionais; `parseSidecarOutput` tolera saída antiga.
- `@decupa/media`: `extractAudio` com `startSeconds`/`durationSeconds` opcionais (chamador único anterior intacto).
- `store.ts`: takes validados (`validateSpeechTake`), migração speechIds→takes via catálogo (tudo-resolve ou `takes: []` + speechIds preservados + reanálise sinalizada; spans fora da fonte caem no mesmo fallback), `write/readHistorySnapshot` (`history/rev-<n>.json`, sem consentimentos/aprovações).
- `revisions.ts`: `applyHistorySnapshot` (conteúdo editorial como revisão nova, permissões/preparação atuais).
- `routes.ts`: `POST /project/edit` (400 ação/referência, 409 stale, 202 com alinhamento em background para correct) e `POST /project/undo` (404 sem histórico, 409 adiante/stale; forma funcional = substitui, sem unir correções antigas de volta). Job publica via CAS; obsoleto descarta; erro vira correction `error` com mídia intacta; pending sobrevive a reload/restart e retoma repetindo o correct no mesmo intervalo.
- `scenes.ts`: propostas novas nascem com `takes: []` (tarefa 6 constrói com evidência).

Ajustes documentados vs plano: (1) takes persistidos na cena já na tarefa 3 (necessário para remove/restore/include); o compilador segue no legado até a tarefa 6 e a prévia é invalidada a cada edição, sem compilador duplo. (2) Snapshots fora do lock de escrita: o CAS do `saveProject` impede snapshot antigo de virar revisão; snapshot órfão em crash é estado válido inerte. Sem dependência nova (`package.json` intocado; acoustics/media já eram deps do cli).

Testes: `words.test.ts` (11, inclui snippet do plano + roundtrip + proteção + snap com PCM sintético), `transcribe.test.ts` (+5: offset 10,2s únicos, unaligned nomeado, vazio), migração de takes (resolve/não-resolve), histórico roundtrip/ausente, undo puro. Comando amplo: 120 passed, 11 failed — todos `routes.test.ts` EPERM de sandbox (G0-F01). `pnpm typecheck` 0 erros, `git diff --check` limpo, `py_compile` OK.
Achados: nenhum P0/P1. Rotas edit/undo não executáveis neste sandbox (mesma causa); recheck fora do sandbox precisa cobrir: edit remove/restore roundtrip HTTP, correct→202→aligned via sidecar fake, undo 404/409 e concorrência (duas edições, edição-durante-alinhamento).
Próxima ação: tarefa 4 (media.ts, importação, Range).

## Tarefa 4 — importar e reproduzir materiais de verdade

Commit: `2ff49be`. Review próprio (não independente).
Requisitos cobertos: R-005 (parcial: importação, lote/categorias, miniaturas, proxy, seek; UI de materiais na tarefa 8).

Implementado:
- Novo `assembly/media.ts`: `ensurePlayback` (proxy H.264/yuv420p+AAC faststart + miniatura JPEG, publicados por rename após probe; parcial nunca vira cache; reuso sem re-rodar ffmpeg; áudio-sem-vídeo sem miniatura), `verifySourceIdentity` (stat tamanho+mtime no caminho rápido, hash no caminho lento/dados antigos; troca no mesmo caminho vira erro com ID).
- `Source`: `name` (exibição), `size?`/`mtimeMs?` (sentinelas); migração preenche nome pelo basename; `sourceFromFile` registra tudo; validação exige nome.
- `routes.ts`: `GET /project/media/:id?view=playback` (proxy verificado, Range real), sem view serve o original registrado (com identidade); `GET /project/thumbnail/:id` (JPEG ou 404 áudio-only); `POST /project/import` (stream para `imports/<uuid>.part`, tamanho declarado validado + teto 8 GiB, probe/hash, reuso por hash, nome UUID + exibição separada, traversal recusado, abort/ENOSPC limpam só a tentativa, 409 desfaz o registrado); `POST /project/source-selection` (included em lote, sem apagar bytes); `POST /project/source-role` (lote `sourceIds[]`, singular compatível). Import fica antes da leitura do body JSON (binário ≠ 1 MiB).
- Nota de produto (cai na UI da tarefa 8): drop copia para o servidor local; seletor nativo referencia o original.

Ajuste documentado vs plano: espaço livre checado de forma reativa (ENOSPC→507 + limpeza) em vez de pré-checagem — stdlib Node não tem statvfs e `df` é frágil entre plataformas; o comportamento observável (sem corrupção, erro claro) é o mesmo.

Testes: `media.test.ts` (6, inclui ffmpeg+probe reais: proxy/miniatura gerados e validados em ~400ms; falha sem publicação; lixo rejeitado; reuso; áudio-only; identidade ausente/trocada mesmo-tamanho). `routes.test.ts` +6 (206+Content-Range, 409 com ID, ausente 404/substituído 409 sem exec, import+reuso+400s, abort sem `.part`, lote/seleção). Comando amplo: 126 passed, 17 failed — todos `routes.test.ts` EPERM (G0-F01; +6 novos também HTTP). `pnpm typecheck` 0 erros, `diff --check` limpo.
Achados: nenhum P0/P1. Recheck HTTP fora do sandbox cobre os 17 de routes (comando G2 do plano).
Próxima ação: tarefa 5 (model.ts/visual.ts, janelas e cobertura).

## Tarefa 5 — janelas visuais e cobertura

Commit: (a registrar). Review próprio (não independente).
Requisitos cobertos: R-006 (parcial: evidência refere a janela enviada + gaps reais; "considerada" na proposta é tarefa 6).

Implementado:
- `model.ts`: cada janela recorta `[fetchStart, end)` com seek de saída (frame-accurate; decisão contra seek de entrada preso a keyframe) e envia SÓ esses bytes pedindo tempos locais `[0, end-fetchStart)`; validação local antes da soma única de `fetchStart`; sobreposição de contexto recortada para `[start, end)`; cache versionado `visual-v2` (envelope com versão/prompt/modelo/sha/limites, rename por janela; janelas antigas temporalmente ambíguas nunca reutilizadas); abort lança em vez de devolver parcial; IDs únicos por janela; clipe reutilizado por tamanho>0.
- `visual.ts`: `visualCoverage` (células de 1s + parcial final; zero descrições = zero cobertura; `unavailable` explícito conta como examinado, sem virar evidência observada); `validateVisual` rejeita início negativo e id duplicado.
- `routes.ts`: análise com visual aprovado recebe `visualCoverage` real (fonte sem vídeo segue vazia).
- Nenhum log embute payload/base64 (nada do envelope é logado).

Testes: `model.test.ts` (6: recorte-diferente-por-janela + soma única + prompt local + parcial final + retomada com 2 reenvios + 2 de cancelamento; o teste antigo "devolve o parcial" atualizado para o comportamento correto) e `visual.test.ts` (7: snippet do plano + zero/unavailable + parcial + validações). Comando amplo: 133 passed, 17 failed — todos `routes.test.ts` EPERM (G0-F01). `pnpm typecheck` 0 erros, `diff --check` limpo.
Achados: nenhum P0/P1. Nota para a tarefa 7: chamar `verifySourceIdentity` antes de reutilizar análises (troca no mesmo caminho); cobertura parcial deve impedir "resultado completo".
Próxima ação: tarefa 6 (scenes.ts: takes, selections, evidência visual).

## Tarefa 6 — compilação e proposta com evidência

Commit: (a registrar). Review próprio (não independente).
Requisitos cobertos: R-007 + R-003/R-004 (takes editados preservados, proteção).

Implementado:
- `scenes.ts`: `compileScenes` consome takes (`retainedRanges`, quantização racional única, fragmentos `take#i`, sliver sub-frame pulado) com fallback legado para cenas sem takes (mesmos frames); V2 com clamp de apoio à cena e à fonte (nunca atravessa); `validateProposal` com `selections` (`takeId` reaproveita cortes/proteções, `speechId` cria take novo; adaptador legado de `speechIds`; duplicata de take existente exige `takeId`), `visualEvidenceIds` (catálogo + `unavailable` rejeitado como fundamento), categorias por role nos dois sentidos, escopo (`changedSceneIds`; fora do escopo preserva idêntico, divergência rejeita), proteção (retido novo precisa cobrir o protegido), fontes excluídas rejeitadas; `annotateSupport` (apoio limitado/removido vira nota no rationale, gaps intactos); `proposeScenes` com snapshot anti-mutação, texto efetivo corrigido nas falas, evidência com confiança/cobertura, categorias/inclusão e takes atuais no prompt.
- `revisions.ts`: `recordPreview` exige artefato da revisão atual; `approveFinal(p, watchedRevision)` exige artefato+prévia atuais, confirmação do assistido, zero gaps e takes com fonte válida+incluída — sem depender de aprovação estrutural.
- `routes.ts`: preview publica `previewArtifact` (hashes) sem gate estrutural; approve-final passa `watchedRevision` (400 sem confirmação, 409 demais).
- `types.ts`/`store.ts`: `Scene.visualEvidenceIds` (+ migração com `[]`).

Testes: `scenes.test.ts` +10 (snippet do plano, legado≡takes em frames, takeId/duplicata, refs/evidência, escopo, proteção, categorias, clamp+nota, texto efetivo, excluídas) e `revisions.test.ts` atualizado para artefato/assistido. Comando amplo: 143 passed, 17 failed — todos `routes.test.ts` EPERM (G0-F01). `pnpm typecheck` 0 erros, `diff --check` limpo.
Achados: nenhum P0/P1. Recheck HTTP fora do sandbox: rotas propose/apply com seleções, preview→artefato→approve com watched, stale real.
Próxima ação: tarefa 7 (preparação automática persistente).

## Gates seguintes

(G1–G7 a preencher durante a execução.)

## Tarefa 7 — preparação automática persistente

Commit: (a registrar). Review próprio (não independente).
Requisitos cobertos: R-001/R-002 (um início leva a cenas+prévia), R-005 (402 sem chamada), R-008 (cancelamento), preparação persistente/retomável.

Implementado:
- `preparation.ts` novo: `runPreparation(dir, baseRevision, req, deps, control)` executa media→audio→visual→proposal→preview persistindo `preparation` (id `prep-<base>-<modo>-…`, stage, por-fonte) após cada resultado; `applyProposal` é o único bump (+1); todo o resto grava na mesma revisão com cheque atômico de id dentro do lock do store; `needsAttention` (erro de análise/etapa ou `visualCoverage.missing`) decide attention vs ready; zero fala / proposta inválida / stale no apply / falha de render em modo preview → interrupted; falha de render com proposta aplicada → attention; abort → cancelled; obsoleto → sai sem escrever. Mutex por diretório colapsa inícios concorrentes na mesma base (o perdedor contendido adota o desfecho; nova tentativa sequencial reexecuta, inclusive após falha/cancelamento). Opt-in pago monotônico via `withGrantedPermissions` (nunca revoga).
- `routes.ts`: `POST /project/prepare` e `/project/adjust` validam 409/402 de forma síncrona e devolvem 202 com a operação `preparing`; o percurso roda em background com `{ signal, isCurrent }` e a operação reflete ready/error ao assentar. `paidBlockedReason` pura (modelo sempre; visual quando há fonte incluída com vídeo; libera por flag de lote, permissão persistida ou opt-in do clique). Novo início cancela o anterior (mesma semântica de analyze/propose); `/project/cancel` existente dispara o cancelled sem escrita extra. `/project/preview` direto mantido (sem mudança de contrato).
- Desvios do plano com motivo: função `runPreparation` em vez da classe `createPreparationRunner` (start/cancel/recover/close) — cancelamento via AbortSignal+op da rota e retomada via novo POST sobre caches (análise por hash, visual por janela) cobrem os casos sem nova abstração; duplicata na rota cancela a anterior em vez de devolver a mesma operação (consistência com analyze/propose; o colapso com adoção existe no nível do runner para chamadas diretas); `begin/opGen` mantido (alimenta `isCurrent`); recuperação pós-restart (running→interrupted + Retomar) fica para a T8 com a UI.

Testes: `preparation.test.ts` (10: snippet ponta a ponta, segunda fonte falha/primeira fica, duplo início com 1 chamada ao provedor, cancelamento, edição durante proposta, gaps→attention, opt-in persiste, proposta inválida→interrupted, preview sem nova proposta, adjust sem cenas 409); `routes.test.ts` + gate puro de `paidBlockedReason` (6 casos) e HTTP 402-sem-chamada + 202→interrupted em projeto vazio; `tests/assembly-flow.test.ts` + fluxo prepare 202→ready com cenas+artefato atuais e final null (snippet do plano) e remoção do passo `approve-structure` extinto. Comando amplo: 111 passed nos arquivos offline; `routes.test.ts`/`assembly-flow` HTTP seguem EPERM no sandbox (G0-F01); `pnpm typecheck` 0 erros, `git diff --check` limpo. Armadilha encontrada: cópias idênticas do clip partilham sha+cache e pulam o ingest (comportamento correto do motor) — o teste de falha por fonte diverge 1 byte.
Achados: nenhum P0/P1. Recheck HTTP fora do sandbox: 402/202/interrupted + fluxo até ready + suíte EPERM existente.
Próxima ação: tarefa 8 (interface A).

## Tarefa 8 — interface A (texto+vídeo lado a lado)

Commit: (a registrar). Review próprio (não independente).
Requisitos cobertos: direção A aprovada (revisão com vídeo à esquerda e texto à direita).

Implementado:
- `page.html` reescrito (esqueleto; `page.css`+`page.js` separados): cabeçalho com Preparar montagem + par único de opt-ins pagos; Materiais (dropzone com input file, Escolher arquivos, lote por checkbox com categorizar-apoio/incluir/excluir, categorias em português Fala/Apoio/Fala+apoio, miniatura/nome/duração, relink, ver original, briefing); Preparação (tabela por arquivo×etapa com contagem real, resumo, erros em details, Retomar/Cancelar); Revisão (grade A: viewer fixo à esquerda, texto à direita; cena ativa, sequência, badge de evidência visual válida, fonte/tempo por take com Ouvir trecho; palavras como botões com textContent+data-word-id+aria-pressed, sem innerHTML/contenteditable; ações Remover/Restaurar/Preservar/Liberar/Corrigir via /project/edit; sequência Subir/Descer; Excluir cena; Desfazer; Ajustar via /adjust; Atualizar prévia; Aprovar desabilitado com prévia desatualizada; downloads OTIO/MP4 após aprovação). Polling retoma preparation running após reload; sucesso com cenas leva à revisão; playhead/foco/seleção preservados (src só troca com data-rev, foco restaurado por word-id, seleção em Set).
- `server.ts` serve somente `/page.css` e `/page.js` além do HTML.
- Removidos da página: 4 abas técnicas, botões de análise/proposta/aplicação manuais, `approve-structure` e `structureApprovedRevision` (rota extinta na T7).

Testes: `node --check` + smoke de DOM falso em /tmp (boot, 1 cena, 2 palavras-botão, toggle de seleção, tabela de preparação, visibilidade das seções — achou bug real: cena sem append, corrigido); teste de rota da página atualizado para os 3 assets; typecheck 0 erros, diff limpo. HTTP e navegador seguem EPERM no sandbox (G0-F01).

Percursos manuais de aceite (para QA fora do sandbox):
- P1 lote: arrastar 2 mp4 → checkbox nos dois → Categorizar como apoio num deles → briefing → Preparar montagem com opt-ins → 202.
- P2 preparação: acompanhar tabela por fonte → Cancelar no meio (status cancelled) → Retomar (conclui) ou aguardar ready/attention com detalhes recolhidos.
- P3 revisão: assistir prévia atual → clicar palavras (seleção amarela) → Remover → Restaurar → Corrigir texto → Subir cena → Atualizar prévia → Aprovar assistida → Exportar → baixar OTIO+MP4 e conferir no DaVinci.
Não verificado nesta sessão: conferência no navegador a 1280/390px (teclado, foco, playback/seek, capturas) e seek fonte→timeline com loadedmetadata/proxy — roteador de QA com os MPs da Feira na tarefa 10.
Próxima ação: tarefa 9 (frames/export) e tarefa 10 (Nilton Pinto real + G0-G7).
