# Inspiração de edição Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extrair uma receita editorial revisável de uma referência de evento/institucional e aplicá-la, com adaptação livre, em outro projeto.

**Architecture:** Analisador local de mudanças visuais e eventos acústicos, seguido de interpretação audiovisual com evidências e persistência local da receita. O compilador existente recebe cenas visuais e trilha; propostas continuam passando por validação e revisão. Não criar outro motor de montagem.

**Tech Stack:** Node >=22, TypeScript, JavaScript nativo no editor, FFmpeg/ffprobe, cliente de análise existente e Vitest. Python/compositor já existente somente no caminho de render atual.

**Spec:** `docs/superpowers/specs/2026-09-12-inspiracao-de-edicao-design.md` — aprovada pelo usuário após o commit `7d1279e`.

## Global Constraints

- Um vídeo de referência por estilo; um estilo pode ser aplicado em vários projetos.
- Adaptação livre ao material disponível, preservando o sentido das falas.
- O usuário escolhe a trilha do novo projeto. O estilo orienta sua relação com a montagem.
- Análise retomável; cobertura incompleta e incerteza aparecem explicitamente.
- Não guardar todos os quadros como imagens permanentes.
- Testes automatizados usam arquivos sintéticos e transportes simulados, sem chamadas pagas.
- Projetos sem estilo mantêm o comportamento atual.
- Sem framework, serviço ou dependência nova. Se alguma se revelar indispensável, apresentar a necessidade concreta antes de adicioná-la.
- Não modificar o checkout `work/video-agent-kit-plugin`, outros planos ICE, `.gitignore` ou trabalho alheio. Stage explícito dos arquivos de cada tarefa.
- Execução em checkout isolado conforme a skill de worktrees; não executar este plano automaticamente ao escrevê-lo.

---

## Descobertas e sequência

Inspeção feita em 2026-09-12. `assembly/model.ts` envia proxy de 1 FPS; não prova cortes precisos. `compileScenes` em `assembly/scenes.ts` avança a duração somente pelos takes de fala; cenas sem fala precisam de suporte explícito. `render.ts` emite volume 1 para áudio; o compositor externo possui suporte a beds e volume, mas isso ainda exige prova no caminho Decupa. O exportador OTIO não representa ganho.

Sequência única, dependente: receita → sinais → interpretação retomável → cenas visuais → trilha → aplicação → interface → aceitação real. As tarefas intermediárias são verificáveis isoladamente, mas a funcionalidade só está entregue após o fluxo completo. Não substituir essa entrega por apenas incluir um estilo no prompt.

## Mapa de arquivos

Novos módulos em `apps/cli/src/app/inspiration/`: `types.ts` (contratos), `store.ts` (validação/persistência), `signals.ts` (sinais locais), `analyze.ts` (interpretação e retomada), `apply.ts` (snapshot/contexto da receita), `routes.ts` (HTTP). Cada módulo comportamental recebe teste adjacente. Manter decodificação específica da referência aqui; não ampliar APIs de pacotes compartilhados sem necessidade.

Alterações concentradas em `assembly/`: `types.ts`, `store.ts`, `scenes.ts`, `preparation.ts`, `routes.ts`, `revisions.ts` e testes existentes para integração; novo `music.ts` e teste para trilha. `render.ts`/`otio.ts` só recebem correções se a prova de composição exigir. `editor/inspiracao.js` e teste contêm UI nova; `page.js`, `page.html`, `page.css` e `editor/texto.js` conectam e representam o fluxo. `apps/cli/src/app/server.ts` exporta `startApp` e passa dependências a `createAssemblyRuntime`; acrescentar ali a injeção da raiz da biblioteca e do analisador para testes.

### Tarefa 1: Contrato, biblioteca local e revisões da receita

**Files:** criar `apps/cli/src/app/inspiration/{types,store,store.test}.ts`.

**Interfaces:** definir os contratos abaixo; `validateStyle(raw: unknown): EditingStyle`, `loadStyle(root: string, id: string): Promise<EditingStyle>`, `saveStyle(root: string, style: EditingStyle, expectedRevision: number | null): Promise<EditingStyle>`, `listStyles(root: string): Promise<EditingStyle[]>`, `relinkStyle(root: string, id: string, path: string, expectedRevision: number): Promise<EditingStyle>`.

```ts
export type Interval = { start: number; end: number };
export type Category = 'structure' | 'visual' | 'rhythm' | 'audio';
export type Evidence = Interval & {
  id: string; method: 'frames' | 'audio' | 'model';
  confidence: 'observed' | 'uncertain'; description: string;
};
export type Rule = {
  id: string; category: Category; observation: string; instruction: string;
  enabled: boolean; edited: boolean;
  confidence: 'observed' | 'uncertain'; evidenceIds: string[];
};
export type Coverage = {
  category: Category; processed: Interval[]; unavailable: Interval[];
  missing: Interval[];
};
export type EditingStyle = {
  version: 1; id: string; name: string; revision: number;
  reference: { path: string; sha256: string; duration: number; hasAudio: boolean };
  status: 'draft' | 'running' | 'interrupted' | 'ready';
  analysisKey: string; coverage: Coverage[];
  evidence: Evidence[]; rules: Rule[]; error?: string;
};
```

- [ ] Escrever teste mínimo de schema e round-trip usando `mkdtemp`, `tmpdir`, `join` e imports Vitest; objeto completo no próprio teste:

```ts
const style: EditingStyle = {
  version: 1, id: 'style-1', name: 'Evento', revision: 0,
  reference: { path: '/tmp/reference.mp4', sha256: 'a'.repeat(64), duration: 1.04, hasAudio: false },
  status: 'draft', analysisKey: 'b'.repeat(64), coverage: [], evidence: [], rules: [],
};
const saved = await saveStyle(root, style, null);
expect(await loadStyle(root, saved.id)).toEqual(saved);
await expect(saveStyle(root, saved, saved.revision - 1)).rejects.toThrow(/revisão/);
expect(() => validateStyle({ ...style, id: '../escape' })).toThrow();
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/store.test.ts`; esperar falha por módulo ausente.
- [ ] Implementar biblioteca em `join(homedir(), '.decupa', 'styles')`, raiz injetável em testes. `saveStyle` usa leitura/revisão sob lock, arquivo temporário exclusivo e rename; criação exige `expectedRevision=null`, revisão inicial 0 e atualizações incrementam 1. Serializar jobs da biblioteca entre processos com lock de arquivo exclusivo; lock existente retorna erro acionável, nunca excluir lock presumidamente antigo. IDs aceitam apenas letras, números, hífen e underscore; rejeitar symlinks nos destinos de escrita. Nenhuma rota aceita raiz arbitrária.
- [ ] Validar valores finitos, SHA-256, IDs únicos, referências de evidência e intervalos `0 <= start < end <= duration`. `ready` exige quatro categorias e nenhuma lacuna; `processed` e `unavailable` devem cobrir `[0,duration)` pela união exata. Alterações humanas não modificam `observation`. Religação compara hash antes de salvar; biblioteca lista receita mesmo com original ausente.

```ts
const temp = join(root, `${style.id}.${randomUUID()}.tmp`);
await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
await rename(temp, join(root, `${style.id}.json`));
```

- [ ] Acrescentar no mesmo teste intervalo fora da duração, revisão concorrente, cauda de 0,04s e religação com hash diferente; rodar teste e `pnpm typecheck`. Commit somente os três arquivos.

### Tarefa 2: Sinais visuais e acústicos com timestamps reais

**Files:** criar `apps/cli/src/app/inspiration/{signals,signals.test}.ts`.

**Interfaces:** exportar `FrameChange = {time:number; score:number}`, `AudioEvent = {time:number; strength:number; kind:'attack'|'possible-beat'}`, `Signals = {duration:number; frameTimes:number[]; changes:FrameChange[]; audio:AudioEvent[]; audioAvailable:boolean}`; `analyzeSignals(path:string, signal:AbortSignal):Promise<Signals>`, `classifyChanges(changes:FrameChange[]):Array<FrameChange & {confidence:'observed'|'uncertain'}>`, `detectAttacks(pcm:Int16Array, sampleRate:number):AudioEvent[]`.

- [ ] Escrever teste puro para pulsos e silêncio; gerar PCM dentro do teste:

```ts
const pcm = new Int16Array(16000);
for (const start of [4000, 12000]) pcm.fill(20000, start, start + 160);
expect(detectAttacks(new Int16Array(16000), 16000)).toEqual([]);
const events = detectAttacks(pcm, 16000);
expect(events.some(e => Math.abs(e.time - 0.25) <= 0.02)).toBe(true);
expect(events.some(e => Math.abs(e.time - 0.75) <= 0.02)).toBe(true);
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/signals.test.ts`; esperar falha de import.
- [ ] Implementar leitura FFmpeg sem shell e sem filtro FPS. Usar `scdet` com limiar 10 para candidatos e `metadata=print` para registros com `pts_time`; confirmar disponibilidade no FFmpeg local com `ffmpeg -hide_banner -filters`. Obter todos os timestamps via ffprobe em saída compacta/stream; nenhum `frameIndex/fps`. Subtrair a origem comum dos streams, mantendo o offset de áudio. Consumir stdout progressivamente e encerrar subprocessos ao cancelar. Não acumular frames em RAM.

```ts
const args = ['-v', 'error', '-i', path, '-an', '-vf',
  'scdet=threshold=10,metadata=print:file=-', '-f', 'null', '-'];
// Executar com spawn('ffmpeg', args, { signal }); parsear registros completos por linha.
```

- [ ] Analisar áudio em janelas limitadas de PCM mono 16kHz, reutilizando `energyEnvelope`; não usar a leitura atual de até 1GB para um vídeo inteiro. Detectar subida local relativa ao RMS recente, com separação mínima de 80ms; agrupar periodicidade somente após pelo menos quatro ataques com intervalos consistentes (desvio relativo <=10%). Rotular como `possible-beat`, nunca certeza. Janelas carregam 0,2s de contexto e descartam eventos duplicados por timestamp. Registrar ausência de áudio separadamente de silêncio.
- [ ] Gerar mídia sintética em pasta temporária com `ffmpeg` lavfi: blocos preto/branco de 1s a 25 FPS, mais flash de um quadro que retorna à cor anterior. Corte sustentado é observado; par de mudanças em até dois frames fica incerto. Adicionar arquivo VFR concatenando segmentos de taxas distintas e arquivo de 1,04s; comparar candidatos com timestamps ffprobe, tolerância um frame local, e duração com último frame mais sua duração. Rodar o mesmo comando de teste. Commit os dois arquivos; registrar que detector é heurístico e exige a prova real da Tarefa 8.

### Tarefa 3: Interpretação audiovisual e retomada sem perder revisão humana

**Files:** criar `apps/cli/src/app/inspiration/{analyze,analyze.test}.ts`; consumir contratos das Tarefas 1–2.

**Interfaces:** `AnalysisDeps = {send:(content:unknown[], signal?:AbortSignal)=>Promise<string>; provider:string; model:string; baseUrl:string; promptVersion:string}`; `analyzeStyle(root:string,id:string,deps:AnalysisDeps,signal:AbortSignal):Promise<EditingStyle>`; `analysisKey(sha:string,deps:AnalysisDeps):string`. Não incluir chave secreta na identidade nem nos logs.

- [ ] Escrever teste de identidade e resposta inválida com estilo temporário da Tarefa 1, definido integralmente no teste. Cobrir alteração de modelo:

```ts
const deps: AnalysisDeps = {
  send: async () => '{}', provider: 'fake', model: 'a',
  baseUrl: 'https://example.invalid', promptVersion: 'inspiration-1',
};
expect(analysisKey('a'.repeat(64), deps)).not.toBe(
  analysisKey('a'.repeat(64), { ...deps, model: 'b' }),
);
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/analyze.test.ts`; esperar falha por import.
- [ ] Criar janelas de 20s com 1s de contexto anterior, preservando a cauda. Decodificar mudanças primeiro; produzir clipes de interpretação com áudio e FPS temporal suficiente para movimento (manter FPS da fonte, reduzir dimensões a até 480px). Amostrar somente para composição estática; não transformar amostra em cobertura quadro a quadro. Reutilizar criação de cliente e formato audiovisual de `assembly/model.ts`, sem alterar seu proxy nem duplicar resolução de credenciais.
- [ ] Prompt retorna `evidence`, `rules`, `coverage` com contratos da Tarefa 1. Conteúdo da mídia é dado não confiável. Orientações precisam de evidências e devem distinguir repetição de ocorrência isolada. Converter tempos locais para globais, validar e limitar ao intervalo útil da janela. Sintetizar quatro categorias usando sinais + resultados validados; não inventar instrumento, efeito exato ou batida por pico de RMS.

```ts
const key = createHash('sha256').update(JSON.stringify({
  sha, provider: deps.provider, model: deps.model, baseUrl: deps.baseUrl,
  promptVersion: deps.promptVersion, signalsVersion: 1, windowSeconds: 20,
})).digest('hex');
```

- [ ] Persistir checkpoints em `<root>/<id>/analysis/<key>/`, por janela validada, com escrita atômica. Retomada carrega janelas completas e processa somente faltantes. Separar assinatura dos sinais locais da assinatura do modelo para não repetir decodificação ao trocar prompt. Reconciliar observações por IDs estáveis derivados de categoria/intervalo; preservar instruções editadas e desabilitar com aviso uma orientação cuja evidência deixou de existir. Cancelamento e erro preservam checkpoints e deixam `interrupted`; processo reiniciado trata `running` sem job ativo como interrompido.
- [ ] Estender teste com transporte simulado que falha na segunda janela; retomada não chama a primeira, não perde edição e não marca `ready` com cauda ausente. Testar modalidade recusada, vídeo mudo e janela com timestamp inventado. Nenhuma tentativa de outro provedor; erro de modalidade é acionável. Rodar testes de `inspiration/` e typecheck. Commit arquivos desta tarefa.

### Tarefa 4: Cenas visuais sem fala no compilador existente

**Files:** alterar `apps/cli/src/app/assembly/{types,store,scenes}.ts`, `scenes.test.ts`, `store.test.ts` e `editor/texto.js`.

**Interfaces:** acrescentar opcional `Scene.visualSequence?: Array<{visualId:string;durationFrames:number}>`. Consumir catálogo visual existente; não criar outro formato de timeline. Para cena com takes, `visualSequence` deve ser ausente/vazio; imagens sobre depoimento continuam em `support`.

- [ ] Acrescentar teste à fixture de `scenes.test.ts`, usando um ID observado já criado nela:

```ts
const scene: Scene = { id:'intro', objective:'Abrir', rationale:'Espaço',
  speechIds:[], takes:[], visualEvidenceIds:[visualId], support:[], gaps:[],
  visualSequence:[{visualId, durationFrames:25}],
};
const a = compileScenes(project, [scene]);
expect(a.tracks.find(t => t.name === 'V1')?.clips[0]?.durationFrames).toBe(25);
expect(a.tracks.find(t => t.name === 'A1')?.clips).toEqual([]);
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/assembly/scenes.test.ts`; esperar falha de duração ausente.
- [ ] Implementar em `resolveScene`, `validateSceneShape`, `compileScenes` e serialização. Na ausência de takes, compilar `visualSequence` consecutiva em V1, avançando cursor por duração validada; áudio de apoio fica mudo. Rejeitar IDs ausentes, fontes excluídas, evidência indisponível, frames não positivos e duração maior que a evidência. Não permitir sequência e takes simultâneos. Reutilizar validação de role support/both.

```ts
// Dentro da cena sem takes, após resolver e validar o span/source:
v1.push({ id: `${scene.id}-visual-${index}`, sceneId: scene.id,
  sourceId: span.sourceId, sourceStartSeconds: span.start,
  startFrame: cursor, durationFrames: item.durationFrames });
cursor += item.durationFrames;
```

- [ ] Mostrar cena visual no editor textual com nome, duração e controles existentes de mover/excluir; ausência de palavras não a torna cena vazia. Auditar callers com `rg -n 'compileScenes|speechIds|scene.takes' apps/cli/src/app/assembly`; conservar limites de support, montagem legada e takes protegidos. Rodar `scenes.test.ts`, `store.test.ts`, `words.test.ts`, `revisions.test.ts` e typecheck. Commit somente os arquivos necessários.

### Tarefa 5: Trilha selecionada, nível revisável e consistência prévia/exportação

**Files:** criar `assembly/{music,music.test}.ts`; alterar `assembly/{types,store,scenes,preparation,routes}.ts`, `render.test.ts`, `otio.test.ts`, `export.test.ts`.

**Interfaces:** `Project.music?: {original:Source; startSeconds:number; gain:number; prepared:Source; events:AudioEvent[]}`; `prepareMusic(source:Source, startSeconds:number, gain:number, dir:string, signal:AbortSignal):Promise<Project['music']>`; `withMusic(assembly:Assembly,music:Project['music']):Assembly`.

- [ ] Testar truncamento pela duração da montagem e preservação de A1, usando fixture Assembly existente:

```ts
const before = structuredClone(assembly.tracks.find(t => t.name === 'A1'));
const result = withMusic(assembly, music);
expect(result.tracks.find(t => t.name === 'A1')).toEqual(before);
const bed = result.tracks.find(t => t.name === 'Music')!.clips[0]!;
expect(bed.startFrame).toBe(0);
expect(bed.durationFrames).toBeLessThanOrEqual(timelineDurationFrames(assembly));
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/assembly/music.test.ts`; esperar import ausente.
- [ ] Implementar seleção local da música sem inseri-la no catálogo de falas. Validar áudio presente, `0 <= startSeconds < duration` e ganho finito `0..1`; default 0,15, ajustável pelo usuário. Gerar WAV derivado com volume aplicado, identificado por hash da fonte/ganho, em pasta de derivados do projeto. Isso mantém o mesmo nível em render e OTIO sem depender de efeito de ganho no importador. Original intacto, nome e hash preservados. Referenciar derivado por `Source` em assembly, mas excluí-lo de ASR e seleção visual; recompor a pista Music após `compileScenes` em todos os callers (preferir chamada única dentro do compilador).

```ts
const args = ['-v','error','-i',source.path,'-vn','-af',`volume=${gain}`,
  '-c:a','pcm_s16le',temporaryWav];
// Validar via probe, publicar por rename; usar sourceStartSeconds=startSeconds na pista.
```

- [ ] Analisar eventos no original com Tarefa 2, subtraindo `startSeconds` para eventos utilizáveis na timeline. Música menor que montagem não entra em loop; informar fim antecipado. Música maior é truncada. Não alterar duração das falas para caber na música. `withMusic(undefined)` retorna montagem idêntica; recompilação substitui pista existente, não duplica.
- [ ] Executar render real com tons sintéticos distintos em fala/música e verificar ambos na saída; comparar amplitude do derivado com ganho pedido e duração exportada. Acrescentar testes OTIO e export para MediaReference do derivado e in-point. Verificar export bundle inclui o derivado ou impede conclusão quando ausente. Rodar testes music/render/otio/export/preparation e typecheck. Não editar compositor externo; falha real deve ser corrigida no adaptador Decupa, sem substituir o motor. Commit arquivos efetivamente alterados.

### Tarefa 6: Aplicação do estilo com snapshot e proposta verificável

**Files:** criar `inspiration/{apply,apply.test}.ts`; alterar `assembly/{types,store,scenes,revisions,preparation}.ts` e testes respectivos.

**Interfaces:** `StyleApplication = {styleId:string;styleRevision:number;rules:Rule[];evidence:Evidence[]}`; `snapshotStyle(style:EditingStyle):StyleApplication`; `styleContext(application:StyleApplication):string`; campo `Project.styleApplication?:StyleApplication`. Acrescentar `Proposal.styleReport?:Array<{ruleId:string;status:'applied'|'adapted'|'unavailable';sceneIds:string[];reason:string}>` e preservar relatório na revisão aplicada.

- [ ] Escrever teste de snapshot sem alias e rejeição de rascunho:

```ts
const snapshot = snapshotStyle(style);
style.rules[0]!.instruction = 'modificação posterior';
expect(snapshot.rules[0]!.instruction).not.toBe('modificação posterior');
expect(() => snapshotStyle({ ...style, status:'draft' })).toThrow(/conclu/);
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/apply.test.ts`; esperar falha de import.
- [ ] Implementar `structuredClone` após validação ready e filtrar regras desativadas. Inserir contexto estruturado no prompt de `proposeScenes`; incluir eventos da música escolhida e opção `visualSequence`. Informar hierarquia: proteção da fala > mídia válida > pertinência > ritmo. Sem estilo, omitir completamente o contexto e preservar formato legado de proposta.

```ts
export function snapshotStyle(style: EditingStyle): StyleApplication {
  if (style.status !== 'ready') throw new Error('Análise não concluída');
  return structuredClone({ styleId:style.id, styleRevision:style.revision,
    rules:style.rules.filter(r => r.enabled), evidence:style.evidence });
}
```

- [ ] Validar relatório contra IDs de regra e cena reais. Status aplicado/adaptado exige cena válida; recurso não suportado recebe unavailable. Resultado é relato do modelo, não prova automática de qualidade. Persistir snapshot/relatório em save, merge e history; undo restaura associação anterior. Alterar estilo na biblioteca não muda projeto já salvo. Mudança de estilo/música invalida prévia e aprovação atuais pelas revisões existentes.
- [ ] Testar transporte simulado capturando prompt e retornando cena visual válida, adaptação de falta de planos e take protegido. Verificar takes/cortes permanecem íntegros, IDs inventados rejeitados e nenhuma regra desativada no prompt. Rodar testes apply/scenes/revisions/store/preparation e typecheck. Commit arquivos necessários.

### Tarefa 7: Fluxo completo no editor e endpoints locais

**Files:** criar `inspiration/{routes,routes.test}.ts`, `assembly/editor/{inspiracao.js,inspiracao.test.ts}`; alterar `assembly/{routes.ts,page.js,page.html,page.css}`, `assembly/editor/texto.js` se necessário. Alterar também `apps/cli/src/app/server.ts`: propagar `stylesRoot?: string` e `inspirationDeps?: AnalysisDeps` de `startApp`/`startAssemblyApp` até `AssemblyDeps` e `createAssemblyRuntime`. Usar essas injeções em testes; no uso normal, resolver a raiz local e o cliente configurado.

**Interfaces:** `mountInspiracao({state,api,root})` usa state/api existentes e elemento DOM raiz; rotas sob `/project/inspiration`, com biblioteca compartilhada injetável. Handler novo é chamado pelo runtime antes do fallback; não copiar o servidor.

| Método e sufixo | Entrada | Resultado |
|---|---|---|
| GET `/styles` | nenhuma | lista de estilos |
| POST `/select` | `{name}` | seletor nativo, um vídeo, rascunho |
| GET `/:id` | ID validado | receita + estado do job |
| GET `/:id/media` | ID validado | stream da referência registrada, suporte a Range |
| POST `/:id/analyze` | `{modelOptIn,visualOptIn}` | 202 + estado; inicia/retoma |
| POST `/:id/cancel` | nenhuma | cancela somente esse job |
| POST `/:id/edit` | `{expectedRevision,edits:[{id,instruction,enabled}]}` | receita revisada |
| POST `/:id/relink` | `{expectedRevision}` | seletor nativo, valida hash |
| POST `/:id/apply` | `{baseRevision}` | projeto com snapshot do estilo |
| POST `/music` | `{baseRevision,startSeconds,gain,select:boolean}` | seleciona/atualiza trilha; nenhuma chamada de IA |
| POST `/music/clear` | `{baseRevision}` | remove associação/pista, conserva mídia |

- [ ] Testar rotas com `startApp` e injeção de seletor/transporte como `assembly/routes.test.ts`; raiz da biblioteca sempre temporária. Teste inicial da lista:

```ts
const res = await fetch(`${base}/project/inspiration/styles`);
expect(res.status).toBe(200);
expect(await res.json()).toEqual({ styles: [] });
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/routes.test.ts`; esperar 404 antes da fiação.
- [ ] Implementar handler com guardas HTTP/origin/body já usados no servidor. Nunca aceitar caminho arbitrário do cliente para streaming; resolver somente referência registrada. Seletor retorna cancelamento sem criar estado. `analyze` exige permissões da referência/lote, sem herdar autorização de outra referência. Duplicatas do mesmo job adotam job existente; cancelar não mata render ou job de outra referência. Guardar permissões concedidas com o job, sem credenciais na biblioteca. Reusar grants da retomada no mesmo escopo.
- [ ] Criar painel com botão “Inspiração de edição”, campo de nome, selecionar referência, progresso/cancelar/retomar, quatro grupos de regras, player próprio e seleção de estilo no projeto. Player separado não interfere no controle de “prévia assistida”. Construir texto do modelo com `textContent`; campos e botões nativos, foco no erro e `aria-live` para progresso. Não reconstruir campos em edição ao receber polling; conflito 409 conserva rascunho local e oferece recarregar.

```js
const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Ver evidência';
button.addEventListener('click', () => {
  referencePlayer.currentTime = evidence.start;
  referencePlayer.play().catch(() => {});
});
```

- [ ] Adicionar seleção da trilha, offset em segundos e ganho com label, aviso sem trilha e aviso música curta. Aplicar estilo salva snapshot e permite “Propor montagem”; não disparar pago ao selecionar estilo. Mostrar relatório por regra com acesso às cenas. Polling só enquanto job ativo; fechar painel não perde trabalho nem exige duplicação de chamadas.
- [ ] Testes: fluxo select→analyze→edit→apply, cancelamento, 409, rejeição de path traversal, mídia ausente/relink, consentimento ausente sem chamadas, botão de evidência e render seguro contra HTML. Reusar padrão de testes DOM existente, sem nova dependência. Rodar testes inspiration, teste novo da UI e testes routes/editor existentes; `pnpm typecheck`. Commit arquivos desta tarefa.

### Tarefa 8: Verificação integrada e aceitação editorial

**Files:** testes existentes alterados somente se encontrarem regressão; criar `docs/superpowers/evidence/2026-09-12-inspiracao-de-edicao.md` com resultados reais e atualizar `docs/skills/decupa/SKILL.md` com acesso à função, sem promessa de geração por MCP.

- [ ] Executar `pnpm test` e `pnpm typecheck` no checkout isolado; registrar saída e commit exato. Corrigir apenas falhas da mudança e repetir checks afetados. Baseline alheia deve ser discriminada.
- [ ] Usar uma referência sintética local para percorrer a UI inteira com transporte simulado: abrir, analisar, editar/desativar orientação, salvar, reabrir, aplicar em segundo projeto, escolher música e produzir prévia. Verificar teclado, reprodução de evidências e identidade das revisões. Essa prova não substitui modelo real.
- [ ] Registrar checklist de comparação real em Markdown:

```markdown
| Verificação | Referência/intervalo | Resultado observado | Evidência |
|---|---|---|---|
| Corte e timestamp | | | |
| Flash versus corte | | | |
| Composição e movimento | | | |
| Relação corte/música | | | |
| Depoimento preservado | | | |
| Estilo em outro conjunto de brutos | | | |
| Trilha e nível na prévia | | | |
| OTIO, mídia online e in-point | | | |
```

- [ ] Antes da execução real, usar arquivos indicados pelo usuário e autorização para chamadas; se faltarem, concluir checks locais e reportar exatamente essa pendência. Executar análise real somente após essa autorização. Preencher tabela com timestamps, divergências e resultado, sem marcar linhas não exercitadas como aprovadas.
- [ ] Importar OTIO da mesma revisão num projeto isolado DaVinci, conferir mídia/áudio, canvas, FPS e in-point da trilha. Não equiparar export JSON válido a importação correta. Se o importador não reproduzir algo suportado pela prévia, corrigir ou registrar a limitação de exportação antes da entrega.
- [ ] Rever diff e comandos finais:

```bash
git diff --check
git diff --stat
git status --short
```

- [ ] Commit somente evidência preenchida e documentação atualizada. Entregar resultado separando testes locais, prova real de análise, prévia, DaVinci e aprovação editorial do usuário. Não publicar nem fazer push por inferência.

## Auto-revisão do plano

Cobertura: biblioteca/revisões/religação (1), quadros/VFR/áudio/cauda (2), quatro categorias/evidências/cache/cancelamento (3), abertura e cobertura sem fala (4), trilha escolhida em prévia/export (5), adaptação livre/proteções/snapshot (6), fluxo/consentimento/acessibilidade (7), qualidade real/DaVinci (8). Nenhuma aprovação de análise real está presumida.

Contratos das tarefas usam os mesmos nomes `EditingStyle`, `Rule`, `Evidence`, `AudioEvent`, `StyleApplication`, `visualSequence` e `music`. `Scene` e `Project` ganham campos opcionais com leitura compatível; adicionar campos aos validadores e persistência é obrigatório, não apenas ao TypeScript. Evolução proposta é local ao escopo aprovado; novos endpoints e arquivos de estilo não demandam migração destrutiva.
