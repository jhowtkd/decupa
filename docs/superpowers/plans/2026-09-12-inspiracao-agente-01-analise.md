# Agente 1 — análise audiovisual e biblioteca

Branch de trabalho: `codex/inspiracao-analise`.

## Leitura e execução

Leia esta divisão e a especificação aprovada: `/Users/jhonatan/Repos/Video editor/docs/superpowers/specs/2026-09-12-inspiracao-de-edicao-design.md`. O plano original está em `/Users/jhonatan/Repos/Video editor/docs/superpowers/plans/2026-09-12-inspiracao-de-edicao.md`. As tarefas completas da sua frente estão copiadas abaixo. **As regras de propriedade e integração desta divisão prevalecem sobre as listas de arquivos das tarefas originais.**

Execute com `superpowers:executing-plans`, sem criar outros agentes. A feature e o desenho estão aprovados; não reinicie brainstorming. Você não está sozinho no repositório: preserve trabalho alheio, não reverta mudanças dos outros e não edite fora da sua propriedade. Faça correções na origem sob responsabilidade do autor.

Base comum para os três: `6f99d21337866f9a9ed7aa635b349ec51f078642`. Crie seu próprio worktree a partir desse commit, seguindo a skill de worktrees. Leia este arquivo pelo caminho absoluto acima antes de trocar de checkout: estas divisões podem não existir no commit base. Não use o checkout original para implementação nem mude sua branch. Não crie stubs de produção ou contratos duplicados para contornar uma dependência ainda não entregue.

Não faça push, merge em main, chamadas pagas, instalação de dependências ou edição do compositor externo. Testes usam dados sintéticos e caminhos temporários. Não altere o plano original nem os arquivos dos outros agentes; reporte progresso no resultado da tarefa.

## Propriedade global

- **Agente 1:** `apps/cli/src/app/inspiration/{types,store,signals,analyze}.ts` e testes adjacentes.
- **Agente 2:** `inspiration/{apply,apply.test}.ts`; `assembly/{types,store,scenes,preparation,revisions,music,render,otio,export}.ts` e respectivos testes, quando necessários à feature. Nenhum arquivo de UI ou rotas.
- **Agente 3:** `inspiration/{routes,routes.test}.ts`, `assembly/{routes,routes.test}.ts`, `apps/cli/src/app/server.ts` e teste do servidor se necessário; `assembly/page.{js,html,css}`, módulos/testes do editor necessários à feature; `docs/skills/decupa/SKILL.md` e evidência final.
- Pacotes compartilhados, dependências, configurações e outros arquivos ficam fora da divisão. Se um bloqueio exigir mudança, descreva arquivo e alteração para coordenar antes de escrever.

## Protocolo de entrega e integração

Entregue a lista **ordenada dos seus próprios commits**, branch, caminho do worktree, comandos/resultados dos testes e pendências concretas. Nunca inclua commits importados de outro agente na sua lista de autoria.

1. Agente 1 publica primeiro o checkpoint **A-core** com Tarefas 1 e 2 implementadas e verificadas; depois continua Tarefa 3.
2. Agente 2 pode implementar Tarefa 4 imediatamente; importa os commits A-core em seu worktree para concluir Tarefas 5 e 6. Se ainda não recebeu os SHAs, peça somente essa entrega; continue trabalho independente. Não fabrique funções dos módulos do agente 1.
3. Agente 3 pode implementar UI com mocks restritos a testes. Para integrar, importa primeiro **todos os commits próprios do agente 1**, depois **somente os commits próprios do agente 2**, em ordem. Isso evita aplicar A-core duas vezes. Não faça merge cego de branches.
4. Agente 3 é responsável pela entrega integrada e verifica testes/fluxo real. Correções em módulos dos agentes 1 e 2 retornam ao respectivo autor, que entrega commit adicional; agente 3 importa e verifica. Não assumir transferência de propriedade.
5. Caso os SHAs ainda não tenham sido encaminhados, indicar qual checkpoint falta. Não declarar feature concluída só porque a frente isolada passou.

Os contratos de `EditingStyle`, `AnalysisDeps`, `AudioEvent`, `visualSequence`, `Project.music` e `StyleApplication` são os do plano original. `AudioEvent` é exportado por `inspiration/signals.ts`, `StyleApplication` por `inspiration/apply.ts`. Agente 2 é o único autor dos campos em `assembly/types.ts`. Agente 3 usa esses contratos sem redefini-los. Qualquer ajuste necessário de assinatura deve ser informado aos consumidores antes de integração.

## Sua entrega

Implemente integralmente as Tarefas 1–3. Você é dono dos sinais, receita, persistência, cache e retomada; não construa HTTP, UI ou montagem.

**Primeiro checkpoint obrigatório:** Tarefas 1 e 2 com implementações reais, tipos exportados e testes passando. Envie os SHAs A-core assim que estiverem disponíveis para liberar o agente 2, depois continue a interpretação sem esperar o restante da feature.

O mesmo extrator será consumido para música sem vídeo: `analyzeSignals` precisa aceitar mídia somente de áudio, retornando `frameTimes: []` e `changes: []` nesse caso, mas preservando `audio` e duração. O cadastro de referência de estilo continua exigindo vídeo. Inclua teste com WAV; não obrigue o agente 2 a duplicar análise de áudio.

`classifyChanges` precisa avaliar intervalo em frames da fonte VFR, não usar 25 FPS implícitos. Caso a assinatura original seja insuficiente, acrescente argumento opcional de timestamps e documente-o no checkpoint, mantendo o contrato de `analyzeSignals`.

A análise não pode perder edições salvas enquanto o job está em andamento: leia a revisão mais recente antes do commit, mescle somente campos da análise e preserve as instruções editadas. Teste esse cenário com saves intercalados. Falha do modelo não pode ser convertida em cobertura indisponível só para atingir ready.

Entregue ao agente 3 exemplos JSON **gerados pelos testes** de draft/ready/interrupted e as assinaturas finais. Não inclua mídia real ou credenciais.

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

## Tarefas originais atribuídas

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
