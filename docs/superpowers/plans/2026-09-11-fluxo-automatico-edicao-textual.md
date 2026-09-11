# Fluxo automático e edição textual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Cursor é o executor escolhido no contexto deste projeto; Codex revisa as entregas. Um autor por vez. Não despachar subagentes nem iniciar execução a partir deste documento sem autorização de execução.

**Goal:** Um início prepara áudio, imagem, proposta e vídeo; o usuário revisa na interface A, corrige a transcrição, remove/restaura falas e exporta a mesma montagem para DaVinci.

**Architecture:** Reutilizar o app local, o catálogo de análise e o motor multipista. Persistir a preparação no projeto; representar escolhas editoriais por intervalos da fonte e palavras por identidade e tempo. Correções de texto não alteram os intervalos selecionados; prévia e OTIO consomem a mesma montagem compilada.

**Tech Stack:** Node.js >=22, pnpm 10.32.1, TypeScript com strip-types, node:http, HTML/CSS/JavaScript, Vitest, FFmpeg, Python e WhisperX já instalados. Nenhuma dependência ou serviço novo.

**Spec:** [Desenho aprovado](../specs/2026-09-11-fluxo-automatico-edicao-textual-design.md), aprovado em 2026-09-11.

## Global Constraints

- “Após selecionar e categorizar os materiais e informar o objetivo, o app prepara automaticamente a montagem: análise de áudio, transcrição, análise visual, proposta e prévia renderizada.”
- “A primeira entrega ao usuário já contém vídeo para assistir e texto editável.”
- “É possível corrigir a transcrição e editar cortes removendo ou restaurando palavras.”
- “Direção visual escolhida: **A — Texto + vídeo**, com vídeo à esquerda, texto à direita e navegação por cenas.”
- “A autorização de uso do provedor já concedida pelo usuário persiste; não criar aprovações por arquivo ou por etapa.”
- “Inserir texto não cria voz.”
- “Não introduzir banco de dados nem um serviço de filas para esse uso local.”
- “A etapa automática não aprova editorialmente nem exporta por conta própria.”
- “A aparência do protótipo não substitui o teste de uso do app implementado.”
- Preservar originais, alterações locais e o fluxo de limpeza. Sem push, merge, publicação, setup-engine.sh, reinstalação do motor, troca de provedor/modelo ou nova dependência.
- 21st.dev: somente catálogo Builder. Não usar generate/iterate, créditos de IA ou upgrade.
- Testes automatizados com chaves removidas e dependências externas injetadas; nunca imprimir valores de credenciais em assertions ou logs.

## Base, execução e marcos

Planejamento aprovado não dispara a implementação. Os contratos abaixo concretizam as mudanças internas de API e armazenamento para a execução posterior.

Estado inspecionado em 2026-09-11:

- Repositório principal: `/Users/jhonatan/Repos/Video editor`; commit do desenho `589f8ff`. O módulo assembly completo ainda não foi integrado nele.
- Cópia que contém a implementação a aproveitar: `/private/tmp/decupa-review-e4e68443`, HEAD `8b0799b` com alterações locais. Não tratá-la como checkout limpo.
- Patch cumulativo recebido: SHA256 `e4e68443ded768b4e5f5b4e808d397fa71d250568eb4fc3e21367b1d89d692d6`. Há correções locais adicionais em scenes.ts, scenes.test.ts e page.html; não reaplicar um patch sobre elas sem comparar.
- Cursor Project existente: [Decupa — montagem multiarquivo para DaVinci](https://cursor.com/agents/bc-251f8c0d-f339-4e63-88f7-ae8b5ff2589d). Preservar o modelo configurado. HEAD remoto anterior `8f4c1f8` é informação do registro, não foi consultado novamente neste planejamento.
- Motor local: `/Users/jhonatan/Repos/Video editor/work/video-agent-kit-plugin`, revisão anteriormente verificada `d9fe30076c00ce2968d570622dd22ba068337568`. Preservar WIP em `mcp/ve_tools/condense_lang.py`; verificar HEAD/status antes da execução.
- Projeto de uso atual: `/private/tmp/decupa-feira-e4e68443`. Criar cópia de projeto para QA; referenciar os originais em `/Users/jhonatan/Downloads/Videos Feira`. Não sobrescrever a montagem editada pelo usuário.

| Marco | Tarefas | Resultado revisável |
| --- | --- | --- |
| Base recuperada | 1 | Código consolidado e regressões existentes identificadas |
| Edição real | 2–3 | Tempos por palavra, correção separada de corte, restauração e desfazer |
| Material compreendido | 4–5 | Entrada/player funcionais e análise visual temporalmente correta |
| Montagem automática | 6–7 | Proposta validada, preparação recuperável e prévia automática |
| Experiência A | 8 | Interface escolhida conectada ao fluxo real |
| Entrega confiável | 9–10 | Frames, exportação e uso real verificados |

Executar em sequência numa branch `codex/fluxo-automatico-edicao-textual`, criada na execução após reconciliar a base. Cada tarefa termina com revisão do diff e commit apenas dos arquivos daquela tarefa. Não usar `git add -A`. Os testes de uma tarefa voltam a rodar somente após alteração relevante ou falha.

## Mapa de arquivos

Os caminhos de código abaixo são relativos à raiz da cópia consolidada, não à pasta dos vídeos.

Nas listas de tarefas, `assembly/` abrevia `apps/cli/src/app/assembly/`, `condense/` abrevia `apps/cli/src/condense/`, e nomes isolados pertencem ao diretório do primeiro arquivo da mesma lista. `server.ts` sempre significa `apps/cli/src/app/server.ts`.

| Arquivo | Alteração/responsabilidade |
| --- | --- |
| `apps/cli/src/app/assembly/types.ts`, `store.ts` | Projeto v2, migração v1, validação, histórico e estado persistido |
| `apps/cli/src/app/assembly/analysis.ts` | Preservar palavras do transcript existente; cache e estados separados |
| **Novo** `apps/cli/src/app/assembly/words.ts` | Catálogo efetivo, correções e operações por palavras/intervalos |
| `apps/cli/src/condense/prepare.ts` | Preservar IDs/confiança disponíveis no transcript sem quebrar leitores antigos |
| `packages/transcript/src/transcribe.ts`, `index.ts`, `services/speech/transcribe.py` | Alinhar texto corrigido usando o WhisperX já presente |
| **Novo** `apps/cli/src/app/assembly/media.ts` | Importação local por stream, miniatura, proxy reproduzível e identidade da fonte |
| `apps/cli/src/app/assembly/model.ts`, `visual.ts` | Vídeo por janela e cobertura visual verificada |
| `apps/cli/src/app/assembly/scenes.ts`, `revisions.ts` | Proposta com evidência, compilação dos cortes e invariantes de revisão |
| **Novo** `apps/cli/src/app/assembly/preparation.ts` | Coordenar e retomar etapas usando estado persistido |
| `apps/cli/src/app/assembly/routes.ts`, `apps/cli/src/app/server.ts` | Ligar operações, mídia e arquivos estáticos com allowlist |
| `apps/cli/src/app/assembly/page.html`, **novos** `page.css`, `page.js` | Substituir a UI por A; separar apresentação e eventos para não ampliar o HTML monolítico |
| `apps/cli/src/app/assembly/render.ts`, `export.ts`, `otio.ts` | Publicação da prévia atual e exportação do mesmo artefato aprovado |
| `scripts/assembly-proof.ts`, `scripts/render-assembly.py` | Prova por frame e ponte do motor |
| `work/video-agent-kit-plugin/mcp/ve_tools/render.py` | Corrigir arredondamento no compositor existente se a reprodução confirmar esse ponto; patch isolado no repo do motor |
| Testes adjacentes existentes; novos `words.test.ts`, `media.test.ts`, `preparation.test.ts` | Regressões comportamentais, sem infraestrutura nova |
| `tests/assembly-flow.test.ts` | Percurso automático com providers simulados |
| **Novo** `docs/superpowers/evidence/2026-09-11-fluxo-automatico-edicao-textual.md` | Comandos, resultados, arquivos e limites de QA; sem chaves ou mídia privada embutida |

## Contratos internos usados nas tarefas

### Projeto, palavras e edição

Em `types.ts`, renomear a forma atual de projeto para `LegacyProject` apenas para leitura/migração. A aplicação trabalha com `Project.version: 2`. `Assembly.version` continua 1: suas pistas e clipes não precisam de outro formato.

```ts
export type SourceRange = { start: number; end: number }; // segundos, [start,end)
export type Word = SourceRange & {
  id: string;
  sourceId: string;
  text: string;
  confidence: number | null;
  cutStart?: number;
  cutEnd?: number;
};
export type SpeechTake = SourceRange & {
  id: string;
  sourceId: string;
  speechId: string | null;
  removed: SourceRange[];
  protected: SourceRange[];
};
export type TextCorrection = SourceRange & {
  id: string;
  sourceId: string;
  text: string;
  status: "pending" | "aligned" | "error";
  words: Word[];
  error?: string;
};
export type StageState = "pending" | "running" | "ready" | "error";
export type Preparation = {
  id: string;
  revision: number;
  mode: "prepare" | "adjust" | "preview";
  request: string;
  status: "running" | "attention" | "interrupted" | "cancelled" | "ready";
  stage: "media" | "audio" | "visual" | "proposal" | "preview";
  sources: Record<string, { media: StageState; audio: StageState; visual: StageState; error?: string }>;
  error?: string;
};
```

Extensões: `Analysis.words: Word[]`, `Analysis.wordsStatus: "ready" | "missing"`, `Analysis.visualCoverage: { requested: SourceRange[]; returned: SourceRange[]; missing: SourceRange[] }`; `Source.included: boolean` com padrão true; `Project.corrections: TextCorrection[]`; `Project.preparation: Preparation | null`; `Project.permissions: { model: boolean; visual: boolean }`; `Project.previewArtifact: { revision: number; assemblySha256: string; relativePath: string; sha256: string } | null`.

`Scene.takes: SpeechTake[]` substitui `Scene.speechIds` no estado persistido. O modelo propõe uma lista ordenada `selections: Array<{takeId: string} | {speechId: string}>`: takeId reutiliza um take existente com seus cortes/proteções, speechId acrescenta fala do catálogo. `validateProposal` resolve IDs no servidor; não aceita timestamps inventados pelo LLM. `Proposal.scenes` contém as cenas já normalizadas, incluindo `visualEvidenceIds: string[]`. Na migração, resolver speechIds usando o catálogo, sem inferir por texto. O adaptador legado converte speechIds para selections no limite de entrada, não duplica compiladores.

A seleção canônica de mídia é cada take menos seus intervalos `removed`. As palavras apontam para a fonte; trocar grafia ou realinhar texto não move a seleção de mídia. Isso evita que uma correção textual altere o áudio sem intenção.

### HTTP local

Todas as mutações mantêm a checagem de Origin existente e CAS por `baseRevision`. JSON mantém o limite atual de 1 MiB. Validar IDs, intervalos finitos, ordenação, inclusão na fonte, revisão e campos desconhecidos relevantes antes de gravar.

| Operação | Corpo/resultado |
| --- | --- |
| `POST /project/prepare` | `{baseRevision}` → 202 com projeto/estado; inicia ou retoma a preparação completa |
| `POST /project/adjust` | `{baseRevision, request}` → 202; proposta e prévia, reutilizando análises |
| `POST /project/preview` | `{baseRevision}` → 202; somente render da revisão atual, sem aprovação intermediária |
| `POST /project/cancel` | Mantém cancelamento; grava cancelled e interrompe apenas a operação ativa |
| `POST /project/edit` | `{baseRevision, action}`; união discriminada definida na tarefa 3 |
| `POST /project/undo` | `{baseRevision, revision}`; restaura conteúdo editorial num novo número de revisão |
| `POST /project/source-selection` | `{baseRevision, sourceIds, included}`; retirar do conjunto sem apagar originais |
| `POST /project/source-role` | Aceitar `sourceIds[]` para operação em lote; manter entrada singular compatível |
| `POST /project/import?name=<nome>&baseRevision=<n>` | Binário de um arquivo, stream local; retorna fonte cadastrada |
| `GET /project/media/:id?view=playback` | Proxy reproduzível da fonte; sem view mantém acesso ao original registrado |
| `GET /project/thumbnail/:id` | Miniatura da fonte registrada |
| `GET /project` | Projeto e preparação persistida; cliente usa polling existente |

`prepare/adjust/preview` não ficam com HTTP aberto durante todo o trabalho. Cliques duplicados retornam a operação ativa compatível. Pedido incompatível com operação ativa retorna 409 com estado atual; alteração editorial invalida/cancela o resultado antigo e agenda a prévia mais recente. Falha de etapa aparece no estado persistido; detalhes técnicos ficam disponíveis fora da interface principal.

Rotas antigas de análise/proposta/aplicação podem permanecer como adaptadores aos mesmos serviços para compatibilidade local; não manter dois coordenadores. Remover o botão e a dependência de aprovação estrutural. O endpoint antigo de aprovação estrutural não pode conceder aprovação final; retirar o campo legado do projeto v2.

`GET /project/output/:revision/mp4` resolve o previewArtifact ou manifest daquela revisão; não monta caminho arbitrário a partir da URL. Validar revision como inteiro não negativo, relativePath dentro do projeto e fonte/artefato registrado antes de servir. A mesma rota existente para OTIO continua lendo a exportação publicada.

---

### Tarefa 1: Consolidar a base existente sem perder correções

**Files:** alterações já existentes na cópia de teste; `docs/superpowers/evidence/2026-09-11-fluxo-automatico-edicao-textual.md`.

**Interfaces:** consome o patch cumulativo e a cópia local; produz uma única base de código com `createAssemblyRuntime`, `analyzeSource`, `proposeScenes`, `compileScenes` e `renderAssembly`, mantendo suas correções existentes.

- [ ] Conferir status, commits e diff do principal, cópia de teste e motor; verificar SHA do patch disponível. Salvar uma cópia do diff e arquivos novos em diretório de trabalho antes de reconciliar. Criar a branch de execução apenas na cópia escolhida; copiar documentos aprovados explicitamente, não o diretório inteiro do usuário.

```bash
git status --short
git diff --stat
git log -3 --oneline
git -C '/Users/jhonatan/Repos/Video editor/work/video-agent-kit-plugin' status --short
shasum -a 256 '/Users/jhonatan/Downloads/entrega_cumulativa_implementation.bin.patch'
```

- [ ] Comparar as correções locais de scenes.ts/scenes.test.ts/page.html com o trabalho do Cursor, preservando snapshot, UUID/revisão no servidor, validação estrita e feedback do botão. Não tomar ausência do patch remoto como motivo para apagar correção local já presente.
- [ ] Rodar os checks de base na cópia consolidada. Se falhar por ambiente ou regressão prévia, registrar a falha e resolver o necessário antes de construir sobre ela. Não atribuir automaticamente a este redesign.

```bash
env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts
pnpm typecheck
git diff --check
```

- [ ] Corrigir o teste que compara o valor de chave com string vazia: testar apenas presença booleana, evitando que uma falha imprima a credencial.

```ts
expect(Boolean(process.env.ZAI_API_KEY)).toBe(false);
expect(Boolean(process.env.OPENAI_API_KEY)).toBe(false);
```

- [ ] Registrar base resultante, comandos e o bug NTSC ainda pendente. Commit da consolidação com allowlist do diff revisado. Nenhum push para transportar trabalho à cloud; manter implementação local se o Cursor remoto não tiver acesso autorizado à base necessária.

### Tarefa 2: Preservar palavras e migrar projetos existentes

**Files:** `assembly/types.ts`, `store.ts`, `analysis.ts`, `fixture.ts`, `store.test.ts`, `analysis.test.ts`; `condense/prepare.ts`, `prepare.test.ts`.

**Interfaces:** produz `wordsFromTranscript(source: Source, raw: unknown): Word[]` em analysis.ts e `validateProject(raw: unknown): Project` normalizando v1/v2. `Analysis.speech` continua existindo para o catálogo de propostas; `Analysis.words` é a granularidade da edição.

- [ ] Adicionar teste de conservação de palavras e rejeição de tempo inválido. Usar o fixture de fonte existente; o tempo do transcript é em segundos.

```ts
const source = fixtureAssembly().sources[0]!;
const raw = { segments: [{ words: [
  { text: "Nilton", start: 0.10, end: 0.40 },
  { text: "Pinto", start: 0.42, end: 0.70 },
] }] };
const words = wordsFromTranscript(source, raw);
expect(words.map(w => w.text)).toEqual(["Nilton", "Pinto"]);
expect(words[1]!.start).toBe(0.42);
expect(new Set(words.map(w => w.id)).size).toBe(2);
expect(() => wordsFromTranscript(source, {
  segments: [{ words: [{ text: "erro", start: 1, end: 0 }] }],
})).toThrow(/intervalo/);
```

- [ ] Rodar `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/analysis.test.ts apps/cli/src/app/assembly/store.test.ts apps/cli/src/condense/prepare.test.ts` e observar falha pelo contrato ainda ausente.
- [ ] Implementar leitura de `transcriptPath(job)` após ingest, sem obter palavras do índice de frases. IDs determinísticos incluem sourceId, hash completo e índice original; preservar confiança quando disponível. Não calcular tempos dividindo duração pelo número de caracteres/palavras.
- [ ] Estender adaptAnalysis para remapear também IDs/sourceId de palavras ao reutilizar o mesmo hash sob outra fonte. Marcar categoria inicial como sugestão e preservar escolha manual; áudio presente não é evidência de fala reconhecida.

```ts
const id = `${source.id}:${source.sha256}:w${String(index).padStart(6, "0")}`;
// index é a posição no array original validado, nunca o texto corrigido.
```

- [ ] Validar de verdade palavras, takes, correções e preparação em store.ts; não usar apenas cast de arrays. Rejeitar duplicatas de ID, números não finitos, tempo negativo/fim fora da fonte e referências ausentes. Fontes sem áudio recebem palavras vazias prontas.
- [ ] Implementar migração v1 → v2: included=true; words ausentes → missing; correções vazias; permissões false até herdar autorização explícita do startup; preparação null. Converter speechIds em takes, preservando montagem/revisão antiga para consulta; se não houver catálogo, mostrar necessidade de reanálise e impedir edição por palavra, sem apagar clipes anteriores.
- [ ] Antes da primeira gravação v2, criar backup exclusivo `project.v1.backup.json`. Carregar por leitura não modifica arquivo. O cache de transcript já existente deve alimentar palavras sem nova ASR; mudar a versão do derivado analysis.json sem invalidar o WAV/transcript válido.
- [ ] Retomar testes, typecheck e diffcheck. Commit: `feat: preserve word timing and migrate assembly projects`.

### Tarefa 3: Cortar, restaurar, corrigir e desfazer sem alterar originais

**Files:** novo `assembly/words.ts`, `words.test.ts`; `types.ts`, `store.ts`, `routes.ts`, `revisions.ts`; `packages/transcript/src/transcribe.ts`, `transcribe.test.ts`, `index.ts`; `services/speech/transcribe.py`.

**Interfaces:** `retainedRanges(take: SpeechTake): SourceRange[]`; `effectiveWords(project: Project, sourceId: string): Word[]`; `applyTextEdit(project: Project, action: EditAction): Project`; `alignText({input, text, startSeconds, endSeconds, language?}): Promise<Transcript>` exportado por @decupa/transcript. `applyTextEdit` é puro, incrementa revisão editorial e invalida aprovação/prévia atual; alinhamento assíncrono é coordenado pela rota usando CAS.

```ts
export type EditAction =
  | { type: "remove" | "restore" | "protect" | "unprotect"; sceneId: string; takeId: string; wordIds: string[] }
  | { type: "correct"; sourceId: string; start: number; end: number; text: string }
  | { type: "include"; sceneId: string; sourceId: string; wordIds: string[] }
  | { type: "move-scene"; sceneId: string; direction: "up" | "down" }
  | { type: "delete-scene"; sceneId: string };
```

- [ ] Acrescentar teste real de subtração de mídia com restauração. Takes sempre usam intervalos semiabertos, inclusões/exclusões normalizadas e sem sobreposição.

```ts
const take: SpeechTake = {
  id: "t1", sourceId: "a", speechId: "a:u001",
  start: 0, end: 2, removed: [{ start: 0.4, end: 0.8 }], protected: [],
};
expect(retainedRanges(take)).toEqual([
  { start: 0, end: 0.4 }, { start: 0.8, end: 2 },
]);
expect(retainedRanges({ ...take, removed: [] })).toEqual([{ start: 0, end: 2 }]);
```

- [ ] Rodar `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/words.test.ts` e observar a falha inicial.
- [ ] Implementar remove/restore resolvendo Word IDs no catálogo efetivo da fonte e limitando-os ao take selecionado. Operar em intervalos da fonte, não em offsets de texto. Restore subtrai exclusões; include cria take para fala existente fora da seleção atual. Preservar a ordem do usuário e rejeitar ID inexistente ou fonte diferente.
- [ ] Na preparação das palavras e no resultado do alinhamento, usar as fronteiras e `snapCut`/silêncios existentes para calcular cutStart/cutEnd, limitados pelos vizinhos e pela seleção explícita. Converter ms↔segundos uma vez; operações puras usam esses limites persistidos, ou start/end quando não houve ajuste acústico. Não fazer I/O dentro de applyTextEdit/compileScenes. Em caso de palavra parcialmente sobreposta ou alinhamento ausente, impedir corte individual e oferecer ouvir o original; não estimar sílabas.
- [ ] Implementar correct como overlay. A seleção de áudio é idêntica antes/depois. Substituir correção anterior sobre o mesmo intervalo; correções parcialmente sobrepostas precisam ser combinadas num único intervalo antes de alinhar. O catálogo original permanece recuperável.
- [ ] Estender o sidecar com `--text-file` opcional. Ler texto UTF-8 de arquivo temporário; quando presente, pular carregamento e execução de ASR e usar whisperx.align no áudio recortado. Mover o load_model atual para o ramo else. Traduzir os tempos de volta à origem da fonte exatamente uma vez. Não criar sidecar/ambiente ou instalar modelo novo para essa tarefa.

```python
# Dentro do sidecar existente: args.text_file é opcional.
if args.text_file:
    from pathlib import Path
    text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("texto vazio para alinhamento")
    segments = [{"start": 0.0, "end": len(audio) / 16000, "text": text}]
else:
    segments = asr.transcribe(audio, batch_size=args.batch_size)["segments"]
# A chamada whisperx.align existente passa a consumir segments.
```

- [ ] Não descartar silenciosamente palavras sem tempo no diagnóstico: registrar o texto não alinhado num campo adicional do resultado. `alignText` valida correspondência/ordem, tempos, cobertura do texto e resultado não vazio. Se não houver vínculo confiável, correção fica error, seleção de áudio anterior permanece intacta e UI oferece original. Alinhamento forçado sozinho não prova que palavras foram faladas; a conferência do caso real permanece obrigatória.
- [ ] Criar teste com transporte/sidecar simulado em transcribe.test.ts: um offset 10s e palavra local 0.2s produz 10.2s uma única vez; palavra não alinhada não ganha tempo inventado. Testar que correct mantém exatamente os takes e que remove+restore devolve a mídia anterior. Reusar injeção de dependência no limite do processo, sem executar WhisperX no teste unitário.
- [ ] Guardar snapshot editorial `history/rev-<n>.json` sob o lock existente antes de cada mutação editorial. Undo aplica o snapshot escolhido como revisão nova, sem restaurar consentimentos, jobs ou aprovações antigos. Nunca decrementar contador. Gravação e restauração passam pela mesma validação/CAS; erro de disco não altera project.json.
- [ ] Registrar correção pendente antes de alinhar e verificar id/revisão antes de publicar resultado. Outra edição ou undo durante alinhamento torna o resultado obsoleto. Reabrir correção pending oferece retomada.
- [ ] Rodar testes tocados e typecheck. Commit: `feat: edit assembly through source-linked words`.

### Tarefa 4: Importar e reproduzir materiais de verdade

**Files:** novo `assembly/media.ts`, `media.test.ts`; `routes.ts`, `routes.test.ts`, `types.ts`; reusar `http/media.ts`, `@decupa/media` e Executor.

**Interfaces:** `ensurePlayback(source: Source, dir: string, exec: Executor): Promise<{ videoPath: string; thumbnailPath: string | null }>`; `verifySourceIdentity(source: Source): Promise<void>`; importação retorna Source validada com nome de exibição. O seletor nativo continua referenciando o original.

- [ ] Adicionar teste de Range em mídia registrada e de falha de geração de proxy sem publicação. Em routes.test.ts, reusar o app/fixture existentes e exigir 206 + Content-Range ao buscar `bytes=0-99` no proxy pronto. Adicionar original ausente/substituído → erro com ID de fonte, sem chamar render.
- [ ] Rodar `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/media.test.ts apps/cli/src/app/assembly/routes.test.ts` antes da implementação.
- [ ] Gerar derivado reproduzível H.264/yuv420p + AAC, faststart e proporção preservada; miniatura em JPEG. Manter origem de tempo zero e duração compatível. Áudio sem vídeo usa player de áudio/estado próprio. Imagem estática recebe miniatura; sem transcrição fictícia.

```ts
const args = ["-n", "-i", source.path,
  "-map", "0:v:0?", "-map", "0:a:0?",
  "-vf", "scale='min(960,iw)':-2", "-c:v", "libx264",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output];
// output é um arquivo temporário único no cache por hash; validar antes de rename.
```

- [ ] Publicar derivados por rename após probe confirmar stream/duração; arquivo parcial nunca vira cache válido. Servir com `serveMedia` para seek por Range. Exportar ainda referencia original, não o proxy de reprodução.
- [ ] Implementar arrastar arquivos por upload **somente ao servidor local**. Navegador não fornece caminho absoluto confiável do File: não usar file.path nem procurar arquivos por basename. Fazer stream para `imports/<uuid>.part`, limitar bytes ao tamanho declarado validado e ao espaço local disponível, tratar abort/ENOSPC, probe/hash, rename e cadastro por CAS. Nunca acumular vídeo em memória ou usar o leitor JSON de 1 MiB.

```js
await fetch(`/project/import?name=${encodeURIComponent(file.name)}&baseRevision=${project.revision}`, {
  method: "POST", headers: { "content-type": "application/octet-stream", "x-file-size": String(file.size) }, body: file,
});
```

- [ ] Usar UUID no nome salvo; nome recebido só para exibição. Rejeitar traversal, tamanho inválido, tipo não decodificável e origem remota. Reutilizar por hash quando já cadastrado. Falha remove somente o `.part` criado pela tentativa; não apagar mídia do usuário. Processar lote de drops em sequência atualizando a revisão retornada.
- [ ] Explicar discretamente na área de drop que arquivos arrastados são copiados para o projeto local. Botão de seleção nativo mantém referência ao original sem cópia. Essa é uma limitação concreta do navegador, não um upload ao provedor.
- [ ] Source.included e categoria em lote passam por CAS; retirar fonte não exclui bytes nem destrói a revisão anterior. Substituição de conteúdo no mesmo caminho cria nova identidade de análise e invalida seleção dependente; relink de hash idêntico apenas atualiza localização.
- [ ] Testar stream interrompido, origem recusada, nomes iguais com conteúdos distintos, alteração no mesmo caminho e segunda importação sem apagar a primeira. Reexecutar checks tocados. Commit: `feat: import and preview local assembly media`.

### Tarefa 5: Corrigir as janelas de análise visual e sua cobertura

**Files:** `assembly/model.ts`, `model.test.ts`, `visual.ts`, `visual.test.ts`, `analysis.ts`.

**Interfaces:** manter `describeSource(source, dir, signal, deps): Promise<VisualSpan[]>`; adicionar `visualCoverage(spans: VisualSpan[], duration: number): Analysis["visualCoverage"]`. `describeSource` só conclui com cache de todas as janelas efetivamente processadas; cobertura ausente vira resultado parcial no coordenador.

- [ ] Registrar a regressão: o código atual lê o mesmo proxy inteiro a cada janela, mas shiftToOrigin soma fetchStart ao resultado. Criar teste verificando recorte diferente da segunda janela, origem local e ausência de dupla soma. Reutilizar Executor/client fakes de model.test.ts.
- [ ] Acrescentar caso de cobertura faltante; zero descrições não significa que todos os segundos foram examinados.

```ts
const coverage = visualCoverage([
  { id: "v0", sourceId: "a", start: 0, end: 1, text: "rosto", confidence: "observed", tags: [] },
], 2);
expect(coverage.missing).toEqual([{ start: 1, end: 2 }]);
```

- [ ] Rodar `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/model.test.ts apps/cli/src/app/assembly/visual.test.ts` e verificar falhas novas.
- [ ] Criar vídeo da janela `[fetchStart,end)` usando FFmpeg, enviar os bytes desse arquivo e pedir apenas tempos locais `[0,end-fetchStart)`. Validar limites locais antes de somar fetchStart; recortar sobreposição de contexto para `[start,end)` e validar na duração da fonte.

```ts
const args = ["-n", "-ss", String(window.fetchStart), "-i", source.path,
  "-t", String(window.end - window.fetchStart),
  "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
  "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", windowPath];
```

- [ ] Versionar somente o cache visual corrigido (`visual-v2`); não reutilizar janelas antigas temporalmente ambíguas nem retranscrever áudio. Cache inclui hash, versão do prompt, modelo e limites. Persistir por janela com rename; validar dados lidos do cache.
- [ ] Exigir cobertura de cada intervalo de um segundo solicitado, incluindo último segundo parcial; aceitar unavailable explicitamente retornado, sem convertê-lo em evidência observada. Um gap não retornado mantém etapa parcial e Retomar solicita apenas o necessário. Sem retries pagos infinitos.
- [ ] Abort deve lançar/propagar cancelamento, não retornar uma lista incompleta como sucesso. Validar start >=0, IDs únicos e confiança; remapear IDs ao reutilizar cache em outra sourceId.
- [ ] Testar janela 20–40 com contexto19, última janela parcial, cancelamento após primeira janela e retomada preservando cache anterior. Rodar checks tocados. Commit: `fix: align visual evidence with sampled source windows`.

### Tarefa 6: Compilar cortes e gerar proposta com evidência visual

**Files:** `assembly/scenes.ts`, `scenes.test.ts`, `revisions.ts`, `revisions.test.ts`, `validate.ts`, `validate.test.ts`.

**Interfaces:** `compileScenes(project: Project, scenes: Scene[]): Assembly` consome takes e retainedRanges; `proposeScenes` mantém assinatura existente; `recordPreview` e `approveFinal` deixam de depender de aprovação de estrutura e passam a exigir artefato/revisão válidos.

- [ ] Adicionar teste com um take [0,2), exclusão [.4,.8) e fps25: dois clipes retidos de10 e30 frames, origem do segundo .8s, timeline do segundo no frame10. A1 e V1 devem coincidir.

```ts
expect(compiled.tracks.find(t => t.name === "A1")!.clips.map(c => [c.startFrame, c.durationFrames, c.sourceStartSeconds]))
  .toEqual([[0, 10, 0], [10, 30, 0.8]]);
```

- [ ] Rodar `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/scenes.test.ts apps/cli/src/app/assembly/revisions.test.ts`.
- [ ] Compilar intervalos da fonte de forma determinística; quantizar início/fim uma vez na taxa racional e acumular frames inteiros. Identificar cada fragmento por take+intervalo; não repetir IDs em fragmentos. Recuperar gaps/apoios quando duração de cena muda: limitar apoio à duração disponível e atualizar a explicação, nunca atravessar outra cena silenciosamente.
- [ ] Enviar ao LLM falas completas, texto efetivo corrigido, evidência visual com confiança/cobertura, categorias e cenas/takes atuais. Usar selections conforme contrato; referência a takeId reaproveita integralmente os cortes existentes. Rejeitar a tentativa de substituir um take editado pelo mesmo speechId completo durante ajuste, a menos que o usuário tenha restaurado o trecho por ação explícita. Preservar trechos protegidos e todos os detalhes de cenas fora de changedSceneIds. Modelo só escolhe falas/takes/visuais conhecidos; o servidor valida a proposta integral antes de aplicá-la.
- [ ] Adicionar ao contrato do modelo `visualEvidenceIds: string[]` por cena para explicar análise considerada mesmo quando não há V2. Validar contra catálogo/cobertura; unavailable não conta como fundamento visual. Mostrar ausência de apoio adequado como informação, não como apoio inventado. Categoria Fala não vira apoio de outra cena por acidente; Fala + apoio autoriza ambos os usos.
- [ ] Não cortar frase/nome para caber no tempo. Pedido inviável retorna lacuna visível para revisão. `protect` impede ajustes automáticos de remover intervalo protegido; tentativa conflitante é rejeitada sem substituir a montagem.
- [ ] `recordPreview` exige resultado do render da revisão atual. `approveFinal` exige previewArtifact atual, sem lacunas bloqueantes, fontes válidas e confirmação da revisão assistida. Não simular aprovação estrutural em nome do usuário para permitir render.
- [ ] Testar metadados falsos do modelo, visualId/evidenceId inexistente, conflito com proteção, modificação fora do escopo e render antigo após editar. Testes existentes de stale real devem continuar recusando. Commit: `feat: compile word edits and ground scene proposals in evidence`.

### Tarefa 7: Preparação automática persistente e retomável

**Files:** novo `assembly/preparation.ts`, `preparation.test.ts`; `routes.ts`, `routes.test.ts`, `store.ts`, `server.ts`, `tests/assembly-flow.test.ts`.

**Interfaces:** `createPreparationRunner(dir: string, deps: PreparationDeps)` retorna `start(baseRevision, mode, request?): Promise<Project>`, `cancel(): Promise<Project>`, `recover(): Promise<void>`, `close(): Promise<void>`. PreparationDeps usa Executor e as mesmas injeções analyzeSource/describeSource/proposeScenes/renderAssembly; definir defaults no módulo, testes fornecem fakes. `start` persiste intenção antes de retornar e o trabalho continua no servidor, não numa cadeia de cliques da página.

```ts
export type PreparationDeps = {
  exec: Executor;
  analyze?: typeof analyzeSource;
  describe?: typeof describeSource;
  propose?: typeof proposeScenes;
  render?: typeof renderAssembly;
  playback?: typeof ensurePlayback;
  verifySource?: typeof verifySourceIdentity;
  proposeSend?: (content: unknown[], signal?: AbortSignal) => Promise<string>;
  describeClient?: { send(content: unknown[], signal?: AbortSignal): Promise<string> };
};
// start(baseRevision: number, mode: Preparation["mode"], request = "")
// Os nomes usados em typeof são importados dos módulos mapeados nas tarefas anteriores.
```

- [ ] Criar teste de fluxo automático no setup HTTP existente: preparar → consultar estado até ready → cenas e previewArtifact atuais, aprovação final null. Usar fixtures de mídia e provider fake; o executor de teste precisa produzir também transcript com palavras e saída de mídia válida quando o teste depende de probe.

```ts
const response = await fetch(`${base}/project/prepare`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ baseRevision: opened.project.revision }),
});
expect(response.status).toBe(202);
// No teste, aguardar vi.waitFor com timeout já limitado pela suíte.
await vi.waitFor(async () => {
  const body = await (await fetch(`${base}/project`)).json();
  expect(body.project.preparation.status).toBe("ready");
  expect(body.project.previewArtifact.revision).toBe(body.project.revision);
  expect(body.project.finalApprovedRevision).toBeNull();
});
```

- [x] Rodar `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly/preparation.test.ts tests/assembly-flow.test.ts` para verificar o percurso ainda ausente.
- [x] Implementar uma operação ativa por projeto, com AbortController e um ID persistido. Reusar a fila/lock de store.ts; callback de saveProject atualiza apenas campos da operação se id+revisão ainda coincidem. Não segurar o lock durante processo externo. Simplificação deliberada: `ponytail: uma operação por projeto; concorrência por fonte somente se a espera medida justificar.`
- [x] Executar etapas na ordem: identidade/mídia; áudio; visual; proposta validada e aplicada automaticamente; compilação/render; registro do artefato. Falha por fonte não impede outras fontes; etapa proposal só começa após todas as análises requeridas do conjunto incluído estarem prontas. Fonte sem áudio/vídeo marca a etapa inaplicável pronta sem inventar conteúdo.
- [x] Guardar estado após cada resultado. As análises reutilizáveis ficam por hash; qualquer publicação no projeto revalida id da operação, revisão e hash da fonte. Incremento de revisão ao aplicar proposta atualiza a revisão esperada da mesma operação na gravação atômica.
- [x] Persistir consentimento já dado quando startup recebe allowPaidModel/allowPaidVisual=true. Reabrir o mesmo projeto respeita permissões persistidas; projeto novo sem autorização continua 402. Não salvar credencial no projeto. Falta de chave/configuração vira ação clara de configuração, sem atribuir sucesso ao provider.
- [ ] Duplicata da mesma preparação devolve a mesma operação; cancelamento interrompe child processes do executor daquela operação. Recuperação após restart marca running como interrupted e oferece Retomar. Falha não entra em loop automático de chamadas.
- [ ] Editar salva a revisão imediatamente. UI agrupa mudanças com debounce de600ms e pede somente a prévia mais recente; runner descarta/cancela render antigo. Reload detecta montagem sem prévia atual e retoma o pedido, sem marcar vídeo anterior como atual. adjust conserva histórico e análises.
- [x] Acrescentar testes com barreiras/promises controladas: segunda fonte falha, primeira fica; reinício detecta interrupção; cancelamento antes de retorno não publica; duas starts iguais chamam provedor uma vez; revisão muda durante proposta; duas prévias não corrompem publicação; autorização persiste sem transformar projeto não autorizado em autorizado.
- [ ] Atualizar adapters antigos para usar os mesmos serviços e tirar begin/opGen paralelo em routes.ts. `close()` cancela, aguarda gravação de estado e fecha processos; resposta HTTP deve terminar sempre em sucesso ou erro claro. Commit: `feat: prepare and resume assembly automatically`.

### Tarefa 8: Implementar a interface A com as referências 21st.dev

**Files:** `assembly/page.html`, novos `page.css`, `page.js`; `server.ts` para servir somente esses arquivos; testes de rota existentes. Referência visual aprovada: `.superpowers/brainstorm/24976-1789133742/content/layouts-feira-v3.html`.

**Interfaces:** page.js usa os endpoints da tabela HTTP. Seu estado é o projeto retornado pelo servidor, não outro modelo editorial no navegador. Player usa a URL do artefato da revisão e o mapa temporal derivado da montagem; original usa sourceId e tempo na fonte.

- [ ] Antes de substituir a página, registrar os três percursos manuais de aceite: materiais em lote, preparação, revisão. Não criar suíte que apenas procura strings no HTML. Os checks de integração ficam nas rotas/fluxo existentes; os visuais são inspecionados no navegador.
- [ ] Aplicar a hierarquia A, usando apenas CSS e DOM existentes/nativos. Grade sugerida:

```css
.review-grid { display:grid; grid-template-columns:minmax(320px,.9fr) minmax(0,1.1fr); gap:24px; }
.transcript { min-width:0; overflow-wrap:anywhere; line-height:1.65; }
.viewer video { display:block; width:100%; aspect-ratio:16/9; object-fit:contain; background:#111; }
:focus-visible { outline:3px solid #8b6800; outline-offset:3px; }
[hidden] { display:none !important; }
@media (max-width:900px) { .review-grid { grid-template-columns:minmax(0,1fr); } }
@media (prefers-reduced-motion:reduce) { *, *::before, *::after { scroll-behavior:auto !important; animation:none !important; } }
```

- [ ] Materiais: dropzone, thumbnails, nome/duração, checkbox para lote, categorias em português, seleção nativa, detalhes/relink contextual, briefing/duração e Preparar montagem. Categoria por menu/botão oferece o mesmo resultado que drag. Não tornar miniatura de arquivo um campo de caminho.
- [ ] Preparação: estado por arquivo/etapa, contagem real, cancelar/retomar, erro legível e detalhes recolhidos. Não mostrar quatro abas técnicas nem botões de autorização repetidos. Sucesso leva automaticamente à revisão quando a prévia atual realmente existe.
- [ ] Revisão: vídeo à esquerda, texto à direita, cena ativa, sequência abaixo; badge de visual baseado em evidenceIds válidos. Mostrar fonte/tempo e apoio nos detalhes. Preservar seleção, foco e playhead entre atualizações; não recriar todo o player a cada polling.
- [ ] Renderizar palavras com textContent e data-word-id; não inserir texto de transcrição/LLM via innerHTML. Selection/Range resolve elementos de palavra para ações explícitas Corrigir texto, Remover, Restaurar e Preservar. Palavras removidas ficam disponíveis em modo de revisão para restauração. Não usar contenteditable irrestrito para alterar áudio por acidente.

```js
const wordButton = document.createElement("button");
wordButton.type = "button";
wordButton.dataset.wordId = word.id;
wordButton.textContent = word.text;
wordButton.setAttribute("aria-label", `Ouvir ${word.text}`);
```

- [ ] Ao clicar em palavra retida, mapear fonte→timeline considerando exclusões; palavra removida oferece original/restauração. Ouvir original mostra claramente a fonte com contexto de1s antes/depois, limitado à duração. Aguardar loadedmetadata para seek; capturar error/play rejeitado e mostrar ação reproduzir/retomar proxy.
- [ ] Corrigir texto abre campo próprio; salvar mantém áudio e exibe alinhamento pendente. Cortes invalidam a prévia e mostram Atualizando prévia. O último vídeo continua identificado como anterior até substituição atômica pela revisão nova.
- [ ] Cena sobe/desce/exclui, desfazer restaura revisão editorial; Pedir ajuste usa /adjust. Exportação contém confirmação editorial da revisão assistida e mostra downloads separados de OTIO/MP4. Não chamar export automaticamente quando render termina.
- [ ] Referências de catálogo: File Upload with Preview de ephraimduncan, Video Player de chetanverma16, Stepper de originui, Inline Edit de0xUrvish — links e aplicação no desenho aprovado. Adaptar a composição ao HTML local; não instalar React, shadcn, pacote21st ou gerar interface remotamente.
- [ ] Conferir no navegador a1280px e390px: drop/categorias, teclado, foco, playback/seek, correção, remover/restaurar, falha/retomar, atualização e downloads. Registrar capturas com mídia sintética quando forem compartilhar evidências. Commit: `feat: redesign assembly review around text and video`.

### Tarefa 9: Precisão de frames, prévia e exportação correspondentes

**Files:** `assembly/render.ts`, `render.test.ts`, `export.ts`, `export.test.ts`, `otio.ts`, `otio.test.ts`; `scripts/assembly-proof.ts`; ponte Python e render.py do motor somente no ponto comprovado pela regressão.

**Interfaces:** `renderAssembly` mantém retorno de caminho; publica artefato isolado por revisão/conteúdo. `exportApproved` passa a copiar a referência já assistida/verificada em vez de renderizar outro vídeo silenciosamente. `previewArtifact` contém hashes da montagem/MP4 e caminho relativo validado.

- [ ] Ampliar assembly-proof.ts para decodificar todos os50frames de cada saída em1pixel RGB e falhar automaticamente se o primeiro azul não for25. Reusar run/promisify existentes; a prova atual só confirma que render não falhou.

```ts
const { stdout } = await run("ffmpeg", ["-v", "error", "-i", mp4,
  "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
  { encoding: "buffer", maxBuffer: 1024 * 1024 });
const rgb = Buffer.from(stdout);
const frameCount = rgb.length / 3;
let firstBlue = -1;
for (let n = 0; n < frameCount; n++) {
  if (rgb[n * 3 + 2]! > rgb[n * 3]! + 80) { firstBlue = n; break; }
}
if (frameCount !== 50 || firstBlue !== 25) {
  throw new Error(`frames=${frameCount}; primeiro azul=${firstBlue}; esperado 50/25`);
}
// mp4 é baselineRender.path ou fractionalRender.path já obtido na prova.
```

- [ ] Rodar a prova real antes do fix para registrar a falha fracionária:

```bash
VE_PLUGIN_ROOT='/Users/jhonatan/Repos/Video editor/work/video-agent-kit-plugin' node --experimental-strip-types scripts/assembly-proof.ts
```

- [ ] Rastrear `toEngineTimeline` → wrapper → render_project_timeline → video_clip_filter/between_expr. O motor inspecionado formata offsets com6casas decimais; 25frames em30000/1001 pode virar limiar posterior ao frame. Corrigir no ponto do compositor que converte intervalos para PTS/enable, usando frame inteiro/timebase racional e limite final exclusivo. Não subtrair epsilon arbitrário por clipe nem alterar o OTIO correto para compensar o render.
- [ ] Para projetos vindos do Decupa, propagar taxa racional e frame de início/duração até a composição; manter entrada legada em segundos normalizada uma única vez. Preservar o comportamento das outras funções do motor e não criar outro compositor. Registrar patch do motor separadamente em `scripts/engine/assembly-frame-boundaries.patch`, base/hash e instrução de aplicação com `git apply --check`; não executar setup-engine.sh.
- [ ] Antes do render verificar hash das fontes; ao publicar, confirmar duração, frames, streams e integridade do MP4. Gravar em caminho único por revisão e hash da montagem; atualizar referência do projeto somente quando ID/revisão ainda correspondem. Resultado antigo pode ficar como artefato histórico, nunca como a prévia atual.
- [ ] Exportação verifica aprovação/artefato/revisão, hash do MP4 e fontes; grava OTIO e copia exatamente o MP4 aprovado para diretório temporário antes de publicar manifest. Recarregar projeto e verificar aprovação/revisão e fontes novamente antes de publicar, detectando edição ou mudança de mídia durante a exportação. Se a revisão mudou, retornar409 e conservar o resultado somente como histórico, sem chamá-lo de entrega atual. Export idempotente só reutiliza manifest cujos hashes continuam corretos.
- [ ] Testar que exportação não chama render novamente; previewArtifact de outra montagem/revisão é recusado; fonte substituída e duas exportações concorrentes conservam a proteção existente. Testar duas prévias terminando fora de ordem, cancelamento e arquivo truncado. Não aceitar apenas access(path) como validação do vídeo.
- [ ] Repetir testes tocados e prova real25/30000/1001 após correção. Commit do app e commit/patch do motor separados; preservar condense_lang.py. Resultado: frame25 azul em ambos,50frames e áudio coerente, OTIO com os mesmos intervalos.

### Tarefa 10: Verificar o uso real completo e entregar evidências

**Files:** `tests/assembly-flow.test.ts` apenas para lacunas reais de aceite; `docs/superpowers/evidence/2026-09-11-fluxo-automatico-edicao-textual.md`.

**Interfaces:** consome o app implementado, os dois vídeos da Feira já autorizados e a exportação; produz evidência separada de testes offline, inspeção no navegador, áudio ouvido e DaVinci.

- [ ] Executar regressões focadas uma vez na base final; executar os testes existentes do fluxo de limpeza afetados por pipeline/transcript/server, além de typecheck. Identificar os arquivos exatos com rg antes de escolher o comando; não rodar transcrição/modelo real dentro da suíte.

```bash
env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts apps/cli/src/condense packages/transcript/src
pnpm typecheck
git diff --check
```

- [ ] Criar cópia de projeto de QA; referenciar originais sem reescrever arquivos. Reutilizar caches válidos e permissões já concedidas para Z.ai/Feira. Não publicar mídia, não mudar provedor e não fazer novas pesquisas pagas fora do escopo.
- [ ] Percorrer materiais → Preparar montagem → revisão sem intervir nas etapas internas. Assistir ao vídeo, observar seek e fonte original, confirmar a evidência visual por cena. Interromper/reabrir uma operação para comprovar retomada e ausência de análise repetida válida.
- [ ] Ouvir o trecho original sobre Nilton Pinto e Tom Carvalho e localizar onde houve perda: saída ASR, palavra sem alinhamento, speech_index, seleção ou render. Registrar tempos e camada comprovada. Corrigir a causa dentro dos módulos já previstos; não declarar causa apenas porque o catálogo omitiu o nome.
- [ ] Corrigir grafia mantendo mídia; remover palavras e ouvir corte; restaurar e ouvir recuperação; incluir fala original ausente; preservar o nome completo; pedir ajuste e conferir que a proteção continua. Desfazer e recarregar conservam estado. Texto sem áudio correspondente não gera voz nem trecho fictício.
- [ ] Exercitar falha de uma fonte com outra pronta, Retomar, mudança de arquivo no mesmo caminho e duas prévias concorrentes usando cópias/sintéticos. Confirmar mensagens e resultado na UI, não só códigos HTTP.
- [ ] Assistir à prévia final, confirmar revisão e baixar os dois arquivos. Abrir OTIO em projeto de teste no DaVinci e conferir duração, V1/V2/A1, canvas, taxa e recortes. Prova25anterior não substitui essa conferência após mudanças.
- [ ] Conferir layout desktop/mobile e teclado; corrigir overflow, foco perdido, player vazio e estados que parecem sucesso antes de estarem prontos.
- [ ] Reconciliar todas as linhas da matriz de aceite abaixo, diffs do app/motor, dependências e registros de chamadas. Commit das evidências sem segredos/mídia privada. Relatar testes, artefatos, limites observados e revisão visual humana separadamente; não fazer push ou declarar produção.

## Matriz de cobertura e revisão do plano

| Requisito do desenho | Tarefas | Prova |
| --- | --- | --- |
| Miniaturas, drop, categorias e lote | 4,8 | Importação/Range + uso por mouse/teclado |
| Automático até prévia | 6,7,8 | assembly-flow e percurso real |
| Estado por fonte, falha, cancelamento/restart | 5,7 | Fakes controlados e retomada na UI |
| Cobertura visual/evidência na proposta | 5,6,8 | Janela real, gaps de cobertura e cena rastreável |
| Tempos por palavra e legado | 2 | Cache sem retranscrição + migração/backup |
| Correção separada de corte/restauração | 3,6 | Mesmos takes após corrigir, intervalos após cortar/restaurar |
| Nome completo e áudio original | 3,6,10 | Ouvir antes/depois e localizar camada da perda |
| Preservar trechos, desfazer, ajustar | 3,6,7,8 | Revisão persistida e proposta conflitante recusada |
| Prévia atual, concorrência e hash de fonte | 4,7,9 | Operação obsoleta, MP4 válido e troca de conteúdo |
| Exportar exatamente o vídeo aprovado | 9,10 | Hash do MP4, OTIO e DaVinci |
| 25 e30000/1001 no frame25 | 9 | Decodificação de50frames, primeiro azul25 |
| Estilo A/21st e acessibilidade | 8,10 | Capturas, leitura, foco e alternativas ao drag |

Self-review do plano: nenhuma dependência nova; contratos de palavras/takes/correções usados de forma consistente; preparação não concede aprovação editorial; modelo não define tempo por palavra; migração preserva originais e projeto anterior. As tarefas de teste utilizam fixtures e injeções existentes; prova real e uso pago autorizado ficam separados da suíte.

## Encaminhamento de execução

Destino preferido: o mesmo Cursor Project, preservando executor/modelo e um autor por vez. Alternativa, se o usuário escolher: executar nesta sessão com superpowers:executing-plans. Não criar outro Project/subagentes por rotina.

Briefing pronto para o executor:

> Implementar este plano e ler o desenho aprovado antes de editar. Começar reconciliando a cópia local e o trabalho anterior, preservando o WIP. Seguir as dez tarefas e devolver marcos com diff, checks e evidências de uso; corrigir achados dentro do escopo até cumprir a matriz. Usar Z.ai apenas no uso real já autorizado, mocks na suíte e21st somente como catálogo. Sem push, merge, deploy, instalação de dependência, reset do motor ou sobrescrita do projeto Feira. Manter o último vídeo/revisão recuperável e nunca substituir a mídia original. A entrega exige funcionamento observado, não apenas aprovação de testes.
