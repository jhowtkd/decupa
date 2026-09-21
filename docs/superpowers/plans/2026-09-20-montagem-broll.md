# B-roll contextual sobre fala — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Escolher, inserir e ajustar imagens de apoio relacionadas à fala, preservando o áudio principal e a revisão humana.

**Architecture:** Reutilizar análises visuais e o cliente Jev da entrega anterior. Candidatos de apoio são janelas contíguas identificadas por IDs reais; Jev escolhe entre eles e none. Compilar as janelas nas entradas de support já existentes e editar pelo endpoint /project/edit, sem criar um motor paralelo.

**Tech Stack:** Node.js >=22.6, pnpm 10.32.1, TypeScript/Vitest, editor JavaScript, FFmpeg e cliente TypeSafe existentes.

**Spec:** `../specs/2026-09-20-montagem-jev-broll.md`, Entrega B. Dependency: `2026-09-20-montagem-jev.md` concluído; usa AssemblyDecisionContext e Proposal.decisionReport definidos ali.

## Global Constraints

- Node.js >=22.6; pnpm 10.32.1; TypeScript, Vitest e FFmpeg existentes.
- Não adicionar dependências, frameworks, serviços nem infraestrutura de testes.
- Preservar mídias originais, alterações locais existentes e projetos version 2.
- Toda aplicação editorial exige baseRevision atual e invalida a aprovação da prévia anterior.
- Não criar confirmação de pagamento a cada operação; usar a configuração já autorizada.
- Testes automáticos usam transportes simulados, nunca chaves ou APIs reais.
- Segredos, frames e transcrições não entram em logs de diagnóstico.
- Revisão humana da prévia continua necessária para exportar.

## Review Focus

- Spans de um segundo, lacunas e fps fracionário: cobertura contínua sem truncamento silencioso — Task 1.
- Fonte excluída, sem vídeo ou mesma fonte da fala coberta: não usar como apoio automático — Tasks 1–2.
- Jev escolhe none, ID inexistente ou fica indisponível: manter fala sem inventar apoio — Task 2.
- Apoio previamente editado e revisão concorrente: preservar decisão manual e recusar resultado antigo — Tasks 2–3.
- Arquivo de apoio contém som alto: V2 aparece e A1 continua sem áudio extra — Task 4.

---

## Estrutura e contratos

Criar `apps/cli/src/app/assembly/broll.ts` e `broll.test.ts`: funções puras de candidatos/intervalos e seleção assíncrona. Reutilizar `compileScenes`, `validateProposal`, `applyEdit`, `writeHistorySnapshot`, render e exporter. Modificar `words.ts`/`types.ts` para uma única ação set-support. Editor usa dados e ações reais; não adicionar controles sem handler.

Contrato novo do módulo:

```ts
export type BrollCandidate = {
  id: string; sourceId: string; visualIds: string[];
  start: number; end: number; description: string;
};
export function brollCandidates(project: Project): BrollCandidate[];
export function candidateSupport(
  project: Project, candidate: BrollCandidate,
  offsetFrames: number, durationFrames: number,
): Scene["support"];
export async function selectBroll(
  project: Project, proposal: Proposal, context: AssemblyDecisionContext,
  signal: AbortSignal,
): Promise<Proposal>;
```

IDs determinísticos: `broll:<sourceId>:<primeiroVisualId>`. Janela inicia na fronteira de span; máximo três segundos. Não expor controles de entrada arbitrária na fonte nesta versão, pois o storage não a representa. Mostrar a entrada real; para outra entrada escolher outra janela.

### Task 1: Janelas contínuas usando o contrato de apoio existente

**Files:** Create `apps/cli/src/app/assembly/broll.ts`, `broll.test.ts`; Modify/Test `scenes.ts`, `scenes.test.ts` somente se a validação atual permitir apoio atravessar lacuna; não alterar analyses.

**Interfaces:** Produces brollCandidates e candidateSupport acima. Consumes Project.analyses, VisualSpan e fps racional. Sem HTTP nem chamadas externas.

- [ ] **Step 1: Testar conversão de três observações em três entradas consecutivas.**

```ts
import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { blankProject } from "./routes.ts";
import { brollCandidates, candidateSupport } from "./broll.ts";

it("preserva três segundos de apoio descritos em spans de um segundo", () => {
  const p = blankProject("teste");
  p.assembly = fixtureAssembly();
  p.analyses = [{ sourceId: "b", key: "k", status: "ready", speech: [], words: [],
    wordsStatus: "ready", visualCoverage: {requested:[],returned:[],missing:[]},
    visual: [0,1,2].map(start => ({id:`b:v${start}`,sourceId:"b",start,end:start+1,
      text:"público participando",confidence:"observed" as const,tags:["público"]})),
  }];
  const candidate = brollCandidates(p)[0]!;
  expect(candidate.end - candidate.start).toBe(3);
  expect(candidateSupport(p, candidate, 25, 75)).toEqual([
    {visualId:"b:v0",offsetFrames:25,durationFrames:25},
    {visualId:"b:v1",offsetFrames:50,durationFrames:25},
    {visualId:"b:v2",offsetFrames:75,durationFrames:25},
  ]);
});
```

Acrescentar casos removendo span central, tornando-o unavailable, excluindo fonte e alterando fps para 30000/1001. Na lacuna, candidato iniciado no primeiro span termina antes dela. No fps racional, soma de durações deve ser diferença entre fronteiras convertidas, não soma de arredondamentos independentes. Teste candidateSupport com duração maior que a janela rejeita, sem clamp silencioso.

- [ ] **Step 2: Rodar e observar falha por módulo inexistente.**

Run: `pnpm vitest run apps/cli/src/app/assembly/broll.test.ts --exclude '**/.muse/**'`

- [ ] **Step 3: Construir janelas e resolver fronteiras.**

Filtrar fontes included, hasVideo e role support/both; spans observed, finitos, dentro da duração. Ordenar sourceId/start/id. Para cada span inicial, avançar enquanto o próximo começa exatamente no fim anterior com tolerância máxima de um frame; sobreposição não pode duplicar duração. Uma lacuna maior termina a janela. End=min(início+3, último fim coberto). Description concatena textos únicos; visualIds contém apenas observações cobertas, ordenadas. Não sintetizar um VisualSpan novo.

```ts
const fps = project.assembly.fps.num / project.assembly.fps.den;
const firstFrame = Math.round(candidate.start * fps);
const lastFrame = firstFrame + durationFrames;
const entries = candidate.visualIds.flatMap(id => {
  const span = visualCatalog(project).get(id)!;
  const a = Math.max(firstFrame, Math.round(span.start * fps));
  const b = Math.min(lastFrame, Math.round(span.end * fps));
  return b > a ? [{visualId:id,offsetFrames:offsetFrames+a-firstFrame,durationFrames:b-a}] : [];
});
```

Validar candidate contra brollCandidates(project), offset inteiro não negativo, duration inteiro positivo e fim dentro da janela. Validar que soma de durações=durationFrames e que offsets são contíguos; rejeitar se não for. A tolerância é para arredondamento de representação, nunca para cobrir frames sem evidência. Cachear visualCatalog uma vez por chamada (fora do flatMap).

- [ ] **Step 4: Executar testes de candidatos, compilação e typecheck.**

```bash
pnpm vitest run apps/cli/src/app/assembly/{broll,scenes}.test.ts --exclude '**/.muse/**'
pnpm typecheck
```

- [ ] **Step 5: Commit dos arquivos próprios.**

```bash
git add -- apps/cli/src/app/assembly/broll.ts apps/cli/src/app/assembly/broll.test.ts
git add -p -- apps/cli/src/app/assembly/scenes.ts apps/cli/src/app/assembly/scenes.test.ts
git diff --cached --check
git commit -m "feat: resolve continuous b-roll candidates"
```

### Task 2: Escolha contextual pelo Jev e aplicação após cortes

**Files:** Modify/Test `apps/cli/src/app/assembly/{broll,broll.test,scenes,scenes.test,preparation,preparation.test,types,store,store.test}.ts`.

**Interfaces:** selectBroll recebe Proposal já decidida pelo plano A; devolve nova Proposal validada. Estender decisionReport com supports opcional conforme spec. O status geral é fallback se alguma fase falhou, completed se houve resposta útil sem falhas e not-run se nenhuma chamada ocorreu. `none` é escolha válida, não erro. Preservar relatório de cortes.

- [ ] **Step 1: Testar a preservação da fala e o caso none.**

No broll.test.ts importar validateProposal, TypeSafeRequest e ChoiceQuestion. Preparação concreta do teste (dentro de it async), seguida do cliente abaixo:

```ts
const p = blankProject("broll");
p.assembly = fixtureAssembly();
p.assembly.sources.find(s => s.id === "a")!.durationSeconds = 6;
p.analyses = [
  {sourceId:"a",key:"a",status:"ready",words:[],wordsStatus:"missing",visual:[],
    visualCoverage:{requested:[],returned:[],missing:[]},
    speech:[{id:"a:one",sourceId:"a",start:0,end:6,text:"O público participou do evento"}]},
  {sourceId:"b",key:"b",status:"ready",words:[],wordsStatus:"missing",speech:[],
    visualCoverage:{requested:[],returned:[],missing:[]},
    visual:[0,1,2].map(start => ({id:`b:v${start}`,sourceId:"b",start,end:start+1,
      text:"Público no evento",confidence:"observed" as const,tags:["público"]}))},
];
const proposal = validateProposal({id:"p",baseRevision:p.revision,changedSceneIds:["s"],explanation:"teste",
  scenes:[{id:"s",selections:[{speechId:"a:one"}],support:[],gaps:[]}]},p);
```

Injetar context.client.decide com esta resposta:

```ts
const client = { decide: async (request: TypeSafeRequest) => ({
  model: "test", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, {
    type: "choice" as const, choice: "none", confidence: 1,
    probabilities: Object.fromEntries(Object.keys((request.questions[id] as ChoiceQuestion).criteria)
      .map(key => [key, key === "none" ? 1 : 0])),
  }])),
}) };
const result = await selectBroll(p, proposal, {mode:"hybrid",model:"test",client}, new AbortController().signal);
expect(result.scenes[0]!.support).toEqual([]);
expect(result.scenes[0]!.takes).toEqual(proposal.scenes[0]!.takes);
```

Testar escolha real com source b; segundo teste já com apoio manual mantém exatamente as entradas anteriores e não consulta essa cena. Testar source a role both não cobre seu próprio take, escolha inválida, throw, abort e mais de vinte candidatos. Observar limites de perguntas por rodada e não reutilização de intervalo entre cenas.

- [ ] **Step 2: Rodar suíte e confirmar que selectBroll ainda falta.**

Run: `pnpm vitest run apps/cli/src/app/assembly/broll.test.ts --exclude '**/.muse/**'`

- [ ] **Step 3: Implementar escolha fechada, sem modificar A1.**

Compilar a proposta para obter duração e fontes por cena após cortes. Ignorar cenas <2s e cenas com support não vazio. Excluir candidato da mesma fonte de qualquer take da cena e intervalos que interceptam apoios já usados na proposta. Ordem de processamento=cenas. Offset=round(fps), duração=min(round(3*fps), frames da janela, frames restantes na cena). Gerar perguntas com ID `support:<sceneId>:<rodada>:<lote>` e critérios descritos pelo ID, fonte, intervalo e conteúdo; estado inclui fala efetiva, objetivo, briefing e pedido.

```ts
const question: ChoiceQuestion = {
  type: "choice",
  instructions: "Escolha a imagem que evidencia o assunto desta fala. Escolha none se não houver relação suficiente.",
  criteria: { none: "Manter vídeo principal", ...Object.fromEntries(batch.map(c => [c.id, c.description])) },
};
```

Máximo vinte candidatos + none por pergunta. Cada lote retorna um vencedor ou none; retirar none e repetir com vencedores até restar um (ou zero). Validar a escolha recebida contra os critérios, inclusive clientes injetados. Qualquer erro nessa cena encerra as rodadas e mantém V1. Em observe registrar sugestão sem aplicar. Com off/sem cliente não consultar. Aplicar candidateSupport e adicionar visualIds reais a visualEvidenceIds; atualizar changedSceneIds apenas nas cenas alteradas. Revalidar proposta. Não sobrescrever falas, cortes ou briefing. Atualizar preparation.note para “Jev escolhendo imagens de apoio”; manter stage proposal. Falha Jev não repete análise visual/geração de cenas.

Registrar resultado selected/none/fallback e razão derivada de dados reais. Contabilizar elapsedMs total das chamadas de decisão, incluindo cortes e apoios; não substituir o tempo anterior. Encadear selectBroll após decideAssemblyCuts e antes de persistir/applyProposal. O gerador não deve preencher support automaticamente em cenas novas quando a seleção por Jev estiver ativa; instruir isso no prompt e rejeitar esse conflito em vez de aplicar duas decisões.

- [ ] **Step 4: Rodar suites e verificar preservação de A1 pelo compilador.**

```bash
pnpm vitest run apps/cli/src/app/assembly/{broll,scenes,preparation,store}.test.ts --exclude '**/.muse/**'
pnpm typecheck
```

Compare compileScenes antes/depois: A1 id/source/start/duration permanecem iguais após apenas inserir apoio; V2 contém a janela selecionada. Não contar sucesso de API como aceite editorial.

- [ ] **Step 5: Commit da integração revisada.**

```bash
git add -p -- apps/cli/src/app/assembly
git diff --cached --check
git commit -m "feat: select contextual b-roll with Jev"
```

### Task 3: Trocar, posicionar e remover apoio pela interface

**Files:** Modify/Test `apps/cli/src/app/assembly/{types,words,words.test,scenes,revisions,revisions.test,routes,routes.test}.ts`, `editor/{contexto,sequencia}.js`, `editor/{contexto,sequencia}.test.ts`, `page.css`; Test `tests/assembly-flow.test.ts`.

**Interfaces:** Nova variante de EditAction, sem novo endpoint:

```ts
| {type:"set-support"; sceneId:string; support:Scene["support"]}
```

Servir o catálogo derivado no GET /project como `brollCandidates: (BrollCandidate & {entries: Scene["support"]})[]`, com entries relativas ao início zero e geradas por candidateSupport. Manter toda descoberta/validação temporal no servidor; não duplicar o algoritmo de candidatos no navegador. Esse envelope é declarado na revisão deste plano. UI ajusta offsets e trunca a última entrada por frames, e o servidor revalida tudo. Sem paths/segredos extras nesse catálogo.

- [ ] **Step 1: Testar a nova ação através de applyEdit.**

```ts
const next = applyEdit(p, {type:"set-support",sceneId:"s1",support:[
  {visualId:"b:v0",offsetFrames:25,durationFrames:25},
]});
expect(next.scenes[0]!.support).toHaveLength(1);
expect(next.assembly.tracks.find(t => t.name === "A1")!.clips)
  .toEqual(p.assembly.tracks.find(t => t.name === "A1")!.clips);
expect(next.revision).toBe(p.revision + 1);
expect(next.finalApprovedRevision).toBeNull();
```

Adicionar no revisions.test.ts usando projeto com cena e A1 já compilados. Parametrizar visualId inexistente, fonte excluída, audio-only, overlap de entradas, offset negativo, duração zero e fim além da cena: todos devem lançar sem alterar p. HTTP com revisão antiga retorna 409. Undo restaura apoio anterior. GET entrega catálogo derivado, sem mutar revision.

- [ ] **Step 2: Executar e confirmar rejeição da ação ainda desconhecida.**

Run: `pnpm vitest run apps/cli/src/app/assembly/{words,revisions,routes}.test.ts --exclude '**/.muse/**'`

- [ ] **Step 3: Implementar ação no caminho único de edição e ligar controles.**

Parser aceita somente sceneId string existente e support array de objetos com visualId string/offset e duração inteiros. Validar fonte, categoria, observação observed, limites fonte/cena e intervalos não sobrepostos na V2. Usar validateProposal com cópia da cena modificada para reaproveitar validação; aplicar bump de revisão pelo mesmo padrão de move-scene/delete-scene. O branch normal de applyEdit recompila, snapshot é gravado pela rota existente e auto-preview é acionado. Preservar visualEvidenceIds não relacionados, acrescentar referências novas e retirar apenas as de apoio removido que não sejam usadas por outro apoio da cena.

No inspetor construir controles nativos select, input number início/duração em segundos e buttons “Aplicar apoio”/“Remover apoio”. Mostrar fonte/descrição/entrada real. Converter entradas para frames uma única vez com fps racional; impedir submit negativo/vazio. Ao trocar, reconstruir só o grupo selecionado; apoio contínuo é definido por mesma fonte, contiguidade de fonte e montagem. POST concreto:

```js
await api.call("/project/edit", {
  method: "POST",
  body: JSON.stringify({baseRevision: state.get("project").revision,
    action:{type:"set-support",sceneId, support: nextSupport}}),
  label: "Atualizando imagem de apoio…",
});
```

`sceneId` vem da cena selecionada; `nextSupport` é a lista completa da cena com apenas o grupo editado substituído. Seleção da V2 grava `selectedSupport` no state com sceneId e primeiro visualId; limpar ao excluir cena ou invalidar grupo. Não mover esse estado a cada timeupdate. Texto e botões explicam quando não há apoio disponível. Mostre relatório IA e opção de voltar ao vídeo principal sem pedir nova chamada paga.

- [ ] **Step 4: Testar servidor e controles em navegador com providers simulados.**

```bash
pnpm vitest run apps/cli/src/app/assembly/{words,revisions,routes}.test.ts apps/cli/src/app/assembly/editor tests/assembly-flow.test.ts --exclude '**/.muse/**'
pnpm typecheck
pnpm exec oxlint apps/cli/src/app/assembly --deny-warnings
```

Em projeto isolado: selecionar bloco V2, trocar janela, alterar posição/duração, remover, desfazer e reproduzir a nova prévia. Capturar requests e exigir zero chamadas de IA para edição manual. Testar viewport 1440 e 390, foco por teclado e feedback 409 preservando dados atuais. Não chamar Exportar no projeto do usuário durante smoke.

- [ ] **Step 5: Commit dos hunks e evidência de navegador.**

```bash
git add -p -- apps/cli/src/app/assembly tests/assembly-flow.test.ts
git diff --cached --check
git commit -m "feat: edit b-roll placement in montage inspector"
```

### Task 4: Prova audiovisual e compatibilidade

**Files:** Extend `apps/cli/src/app/assembly/render.test.ts`, `tests/assembly-flow.test.ts`, usando Vitest e SpawnExecutor existentes também para o caso de render real. Não há suíte Python de render identificada nesta base; não inventar nem adicionar outro runner. Docs: registrar evidências em `docs/superpowers/plans/2026-09-20-montagem-broll.md` na execução.

**Interfaces:** toEngineTimeline(assembly), renderAssembly(assembly, dir, exec), exportApproved(project, dir) existentes; não mudar formatos nem aprovação.

- [ ] **Step 1: Testar áudio de apoio explicitamente mudo no payload do motor.**

```ts
const a = fixtureAssembly();
a.sources.find(s => s.id === "b")!.hasAudio = true;
const timeline = toEngineTimeline(a) as {tracks:{name:string;clips:{muted:boolean;volume:number}[]}[]};
expect(timeline.tracks.find(t => t.name === "V2")!.clips.every(c => c.muted && c.volume === 0)).toBe(true);
expect(timeline.tracks.find(t => t.name === "A1")!.clips.every(c => !c.muted && c.volume === 1)).toBe(true);
```

Esse teste pode já passar: fixa uma invariável, não mudar código só para fazê-lo falhar. Na integração exigir V2 com três spans contíguos, A1 intacto, nenhuma revisão aprovada automaticamente e projeto antigo sem relatório ainda abrindo.

- [ ] **Step 2: Executar baseline audiovisual existente.**

Run: `pnpm vitest run apps/cli/src/app/assembly/render.test.ts tests/assembly-flow.test.ts --exclude '**/.muse/**'`. Registrar comportamento antes do teste real de render.

- [ ] **Step 3: Criar fontes sintéticas apenas no diretório temporário da fixture de render.**

```bash
ffmpeg -y -f lavfi -i color=c=red:s=320x240:r=25:d=6 -f lavfi -i sine=frequency=440:duration=6 -c:v libx264 -c:a aac -shortest fala.mp4
ffmpeg -y -f lavfi -i color=c=blue:s=320x240:r=25:d=3 -f lavfi -i sine=frequency=880:duration=3 -c:v libx264 -c:a aac -shortest apoio.mp4
```

Executar somente dentro de mkdtemp da suíte, nunca no cwd pessoal. Construir projeto de seis segundos com apoio entre 1s e 4s, chamar renderAssembly com executor real. Decodificar frames em 0.5, 2 e 4.5 segundos: vermelho/azul/vermelho. Extrair áudio mono PCM s16le a 16000Hz entre 1.2s e 3.8s via ffmpeg, ler Buffer como int16 e comparar energia em 440Hz versus 880Hz com JS puro:

```ts
function toneEnergy(samples: number[], hz: number, rate = 16000) {
  let re = 0, im = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = 2 * Math.PI * hz * i / rate;
    re += samples[i]! * Math.cos(phase);
    im += samples[i]! * Math.sin(phase);
  }
  return re * re + im * im;
}
expect(toneEnergy(samples, 440)).toBeGreaterThan(50 * toneEnergy(samples, 880));
```

O teste obtém samples do PCM do MP4 final, não do original. Extrair cada frame como rawvideo rgb24 de um pixel (scale=1:1); vermelho exige R > 150 e B < 80, azul exige B > 150 e R < 80. Fonte original preservada por hash. Não adicionar biblioteca nem fazer download de mídia.

- [ ] **Step 4: Aceite integrado e piloto registrado.**

Run: `pnpm vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts tests/assembly-delivery.test.ts --exclude '**/.muse/**'`, `pnpm typecheck`, lint e o novo caso audiovisual na suíte render.test.ts. No navegador confirmar transição visível e voz contínua em material real autorizado, num projeto isolado. Registrar tempo de análise, geração, Jev, render e reaproveitamento de cache; sem estimar tempo total a partir dos antigos 93 segundos. O piloto só passa editorialmente quando o apoio escolhido é relevante para a fala; rejeição humana não é escondida por testes verdes.

- [ ] **Step 5: Commit e fechamento do escopo.**

```bash
git add -p -- apps/cli/src/app/assembly/render.test.ts tests/assembly-flow.test.ts docs/superpowers/plans/2026-09-20-montagem-broll.md
git diff --cached --check
git commit -m "test: verify b-roll picture and continuous speech audio"
```

## Handoff e cobertura

Task 1 prova cobertura temporal; Task 2 escolha real; Task 3 controle do editor; Task 4 render/áudio/compatibilidade. A versão entrega fala com apoio. Montagem só visual com música continua explicitamente fora, sem UI anunciando suporte. Não executar este plano antes do plano Jev nem copiar código do protótipo como motor.

## Evidências de execução — 20/09/2026

- Verificação local integrada: 361 testes em 37 arquivos; typecheck, oxlint e diff-check passaram.
- Navegador em projeto sintético isolado: Montar, relatório Jev, reprodução, posição/duração do apoio, remoção e Desfazer verificados. Corrigida a atualização do estado de prévia que deixava controles desabilitados.
- Falha simulada do Jev: fallback visível, V1/A1 preservados; nenhuma confirmação paga por operação.
- Render real FFmpeg: V1 vermelho em 0,5 s, V2 azul em 2 s, retorno a V1 em 4,5 s; energia da voz em 440 Hz superior a 50 vezes o áudio do apoio em 880 Hz. Mídias originais mantêm os hashes.
- Piloto pago com transcrição de victor.MOV bloqueado pela revisão automática: exige autorização específica do envio textual para Z.ai e TypeSafe. Não houve chamada real nesta execução. Aprovação editorial de b-roll real permanece pendente: projeto disponível contém somente uma fonte de fala incluída e nenhum apoio.
- Interface/API: sem dependências novas e sem alteração do formato version 2; relatório é opcional. Projeto pessoal e WIP anterior preservados no checkout original durante a implementação.

Revisão independente (gpt-6-astra) concluída: dois achados importantes corrigidos com regressões RED→GREEN (apoio do gerador sem Jev; ajuste truncando apoio manual). Seleção de grupo na V2 também reproduzida e corrigida no navegador: selecionar/remover o primeiro grupo preserva o segundo. Cancelamento durante escolha de apoio preserva a montagem anterior. Nova suíte integrada: 361/361; typecheck e oxlint limpos. Sem achados menores adiados.
