# Jev na montagem funcional — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer Jev decidir cortes elegíveis na montagem real, com briefing, histórico e resultado visível.

**Architecture:** O gerador atual continua produzindo cenas e propõe candidatos fechados. Um adaptador de montagem resolve esses candidatos, envia contexto textual ao cliente TypeSafe existente e aplica somente cortes autorizados antes da compilação. A ativação ocorre na operação útil, não num ping de inicialização.

**Tech Stack:** Node.js >=22.6, pnpm 10.32.1, TypeScript, Vitest, cliente TypeSafe existente, JavaScript nativo no editor.

**Spec:** `../specs/2026-09-20-montagem-jev-broll.md`, requisitos globais e Entrega A. Ler também `2026-09-17-decupa-decisoes-rapidas.md` como histórico; o limite antigo “somente Limpar” é substituído apenas neste plano.

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

- Take protegido ou já editado: decisão externa não remove a intervenção humana — Task 2.
- Todos os candidatos autorizados: nunca esvaziar a última fala de uma cena — Task 2.
- Cancelamento ou edição durante chamada: não publicar resposta atrasada — Task 3.
- Chave presente com modo off, observe ou sem arquivo: respeitar a precedência declarada — Task 3.
- Reinício após montagem: Desfazer depende de snapshot persistido, não apenas de revision > 0 — Task 4.

---

## Estrutura e sequência

Modificar `scenes.ts`/`scenes.test.ts` para prompt e integração, criar `assembly-decisions.ts`/`.test.ts` junto deles para candidatos, cliente e política de montagem. Modificar `types.ts` e `store.ts` apenas para relatório opcional validado. `server.ts`, `routes.ts` e `preparation.ts` passam a dependência interna; `editor/contexto.js` mostra o resultado. Não modificar o adaptador da limpeza nem a política global do TypeSafe.

Caminhos de montagem neste documento começam em `apps/cli/src/app/assembly/`. Antes de executar: `git status --short`, registrar `git diff` e arquivos não rastreados. Há WIP anterior em server, credenciais, setup e no editor: nunca usar `git add .`. Se isolar, usar using-git-worktrees no momento da execução e levar a base de trabalho pertinente sem descartar o checkout atual.

### Task 1: Briefing efetivamente usado pela proposta

**Files:** Modify/Test `apps/cli/src/app/assembly/scenes.ts`, `scenes.test.ts`.

**Interfaces:** Consumes `Project.input` e `proposeScenes(project, input, signal, deps)` existentes. Produces o mesmo `Promise<Proposal>`; nenhuma alteração HTTP nesta tarefa.

- [ ] **Step 1: Acrescentar regressão ao arquivo de testes, usando seu helper project() existente.**

```ts
it("envia briefing salvo e pedido adicional sem apagar a duração", async () => {
  const p = project();
  let sent = "";
  await proposeScenes(p, "destacar abertura", new AbortController().signal, {
    send: async content => {
      sent = JSON.stringify(content);
      return JSON.stringify({ id: "p", baseRevision: 1, scenes: [], changedSceneIds: [], explanation: "sem proposta" });
    },
  });
  expect(sent).toContain("abrir com o tema");
  expect(sent).toContain("targetSeconds");
  expect(sent).toContain("destacar abertura");
});
```

- [ ] **Step 2: Executar e observar a falha pelo briefing ausente.**

Run: `pnpm vitest run apps/cli/src/app/assembly/scenes.test.ts --exclude '**/.muse/**'`

- [ ] **Step 3: Incluir contexto salvo antes do pedido adicional; ampliar o prompt com o contrato de candidatos.**

```ts
`briefing salvo: ${JSON.stringify(snapshot.input)}`,
`pedido adicional: ${input}`,
```

Adicionar literalmente ao SCENE_PROMPT: “Informe objective e rationale por cena. Opcionalmente retorne cutCandidates: [{sceneId, speechId, reason}] para remoção de um take completo que ainda esteja presente nas cenas propostas. Não execute esses cortes na proposta: a decisão será feita separadamente. Duração alvo não autoriza truncar uma frase.” Não exigir candidatos nem fabricar um apenas para chamar Jev.

- [ ] **Step 4: Reexecutar a suíte acima e typecheck.**

Run: `pnpm typecheck`. Expected: PASS; transporte falso, zero APIs reais.

- [ ] **Step 5: Revisar e commitar somente os hunks desta tarefa.**

```bash
git add -p -- apps/cli/src/app/assembly/scenes.ts apps/cli/src/app/assembly/scenes.test.ts
git diff --cached --check
git commit -m "fix: pass saved brief to assembly proposal"
```

### Task 2: Candidatos fechados e política Jev com contexto

**Files:** Create `apps/cli/src/app/assembly/assembly-decisions.ts`, `assembly-decisions.test.ts`; Modify/Test `types.ts`, `store.ts`, `store.test.ts`, `scenes.ts`, `scenes.test.ts`.

**Interfaces:** Produces as exportações abaixo. `DecisionClient` é estruturalmente compatível com `TypeSafeClient`; não criar outro transporte HTTP.

```ts
export type CutCandidate = {
  id: string; sceneId: string; takeId: string; text: string;
  before: string; after: string; reason: string;
};
export type DecisionClient = Pick<TypeSafeClient, "decide">;
export type AssemblyDecisionContext = {
  mode: "off" | "observe" | "hybrid";
  client?: DecisionClient;
  model: string;
};
export function resolveCutCandidates(project: Project, proposal: Proposal, raw: unknown): CutCandidate[];
export async function decideAssemblyCuts(
  project: Project, proposal: Proposal, candidates: CutCandidate[],
  context: AssemblyDecisionContext, signal: AbortSignal,
): Promise<Proposal>;
```

Imports: `TypeSafeClient`, `authorizesCut`, `TypeSafeRequest`, `TypeSafeHttpError` de `@decupa/typesafe`; `Project`, `Proposal` locais. Estender Proposal com decisionReport conforme a especificação. O relatório só contém primitivas e arrays limitados aos candidatos enviados. Validar enum, números finitos não negativos e score nulo ou [0,1] no leitor do projeto; rejeitar relatórios malformados, aceitar ausência. `validateProposal` preserva apenas o relatório validado gerado pelo servidor, nunca um relatório fornecido pelo modelo.

- [ ] **Step 1: Acrescentar testes de candidatos no scenes.test.ts, que já tem project().**

```ts
it("não transforma take protegido em candidato de corte", () => {
  const p = project();
  const proposal = validateProposal({
    id: "p", baseRevision: 1, changedSceneIds: ["s"], explanation: "teste",
    scenes: [{ id: "s", selections: [{ speechId: "a:u001" }], support: [], gaps: [] }],
  }, p);
  // Acrescenta um segundo take válido para a proteção ser o único motivo de exclusão.
  p.analyses[0]!.speech.push({id:"a:u002",sourceId:"a",start:2,end:3,text:"encerramento"});
  proposal.scenes[0]!.takes.push({id:"s:second",sourceId:"a",speechId:"a:u002",start:2,end:3,removed:[],protected:[]});
  proposal.scenes[0]!.speechIds.push("a:u002");
  expect(resolveCutCandidates(p, proposal, [{sceneId:"s",speechId:"a:u001",reason:"repetição"}])).toHaveLength(1);
  proposal.scenes[0]!.takes[0]!.protected = [{ start: 0, end: 1 }];
  expect(resolveCutCandidates(p, proposal, [{ sceneId: "s", speechId: "a:u001", reason: "repetição" }])).toEqual([]);
});
```

Importar resolveCutCandidates do módulo novo. No novo teste, cobrir authorizesCut nos valores 0, 0.51, 0.52, 1 e resposta inválida; cobrir todos autorizados sem esvaziar cena. Construir Proposal com duas falas reais do helper local, nunca usar IDs inexistentes. Testar modo observe mantendo takes e relatório applied=false; modo off e lista vazia têm zero chamadas. Acrescentar no store.test.ts roundtrip de relatório e compatibilidade com ausência.

Teste mínimo completo para o arquivo novo `assembly-decisions.test.ts`:

```ts
import { expect, it } from "vitest";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { validateProposal } from "./scenes.ts";
import { decideAssemblyCuts, resolveCutCandidates, type AssemblyDecisionContext } from "./assembly-decisions.ts";

it.each([[0.51, 2], [0.52, 1]])("decide corte com score %s", async (score, takeCount) => {
  const p = blankProject("teste");
  p.assembly = fixtureAssembly();
  p.analyses = [{sourceId:"a",key:"k",status:"ready",words:[],wordsStatus:"missing",
    visual:[],visualCoverage:{requested:[],returned:[],missing:[]},speech:[
      {id:"a:one",sourceId:"a",start:0,end:1,text:"abertura repetida"},
      {id:"a:two",sourceId:"a",start:1,end:2,text:"informação principal"},
    ]}];
  const proposal = validateProposal({id:"p",baseRevision:p.revision,changedSceneIds:["s"],explanation:"teste",
    scenes:[{id:"s",selections:[{speechId:"a:one"},{speechId:"a:two"}],support:[],gaps:[]}]},p);
  const candidates = resolveCutCandidates(p,proposal,[{sceneId:"s",speechId:"a:one",reason:"repetição"}]);
  let state = "";
  const context: AssemblyDecisionContext = {mode:"hybrid",model:"test",client:{
    decide: async req => {
      state = JSON.stringify(req.state);
      return {model:"test",answers:Object.fromEntries(Object.keys(req.questions).map(id => [id,{type:"noul" as const,noul:score}]))};
    },
  }};
  const result = await decideAssemblyCuts(p,proposal,candidates,context,new AbortController().signal);
  expect(result.scenes[0]!.takes).toHaveLength(takeCount);
  expect(proposal.scenes[0]!.takes).toHaveLength(2);
  expect(state).toContain("abertura repetida");
  expect(state).toContain("informação principal");
});
```

- [ ] **Step 2: Rodar testes e confirmar falha pela exportação inexistente.**

Run: `pnpm vitest run apps/cli/src/app/assembly/{scenes,assembly-decisions,store}.test.ts --exclude '**/.muse/**'`

- [ ] **Step 3: Resolver candidatos e implementar a decisão.**

Resolver sceneId e speechId na proposta validada; exigir exatamente um take correspondente. Recusar IDs ausentes, duplicatas e reason vazio com erro de proposta. Excluir takes com removed/protected não vazios, cenas já com apoio e cenas com um único take. Extrair texto por effectiveSpanText e vizinhos da mesma fonte em ordem temporal. Não aceitar caminhos de mídia como parte do estado. IDs são gerados pelo servidor, não pelo modelo.

Núcleo da chamada:

```ts
const questions = Object.fromEntries(candidates.map(c => [c.id, {
  type: "noul" as const,
  instructions: "A remoção integral deste trecho atende ao briefing sem perder informação necessária? Na dúvida mantenha.",
  criteria: { true: "Corte justificado pelo contexto", false: "Preservar informação, ressalva ou contexto" },
}]));
const result = await context.client!.decide({
  model: context.model,
  state: { brief: project.input, request: project.preparation?.request ?? "", candidates },
  questions,
}, signal);
signal.throwIfAborted();
```

Dividir em lotes de no máximo vinte candidatos. Se um lote falhar, manter todos os takes daquele lote; não reenviar lotes concluídos. Clonar a proposta; iterar candidatos na ordem cena/take. Aplicar somente se mode=hybrid, answer.type=noul, authorizesCut(answer.noul) e cena ainda tem mais de um take. Remover o take e atualizar speechIds para os takes restantes; manter IDs e changedSceneIds. Não usar uma nota “cortado” sem remover mídia. Revalidar com validateProposal antes de retornar. Erro de transporte/formato mantém os takes do lote afetado, status=fallback e scores nulos nesse lote; cancelamento é relançado. Elapsed usa performance.now(); motivo usa categoria (401/422 configuração, 429/529 indisponibilidade, outro erro), nunca error.message bruto. Tipos opcionais do relatório seguem a spec.

- [ ] **Step 4: Executar os testes, typecheck e lint da montagem.**

```bash
pnpm vitest run apps/cli/src/app/assembly/{scenes,assembly-decisions,store}.test.ts --exclude '**/.muse/**'
pnpm typecheck
pnpm exec oxlint apps/cli/src/app/assembly --deny-warnings
```

- [ ] **Step 5: Commit isolado após revisão dos hunks e dos arquivos novos.**

```bash
git add -- apps/cli/src/app/assembly/assembly-decisions.ts apps/cli/src/app/assembly/assembly-decisions.test.ts
git add -p -- apps/cli/src/app/assembly/types.ts apps/cli/src/app/assembly/store.ts apps/cli/src/app/assembly/store.test.ts apps/cli/src/app/assembly/scenes.ts apps/cli/src/app/assembly/scenes.test.ts
git diff --cached --check
git commit -m "feat: decide eligible assembly cuts with Jev"
```

### Task 3: Conectar configuração, chamada útil e cancelamento ao percurso

**Files:** Modify `apps/cli/src/app/server.ts`, `assembly/{assembly-decisions,preparation,routes,scenes}.ts`; Test `assembly/{assembly-decisions,preparation,routes,scenes}.test.ts`, `tests/assembly-flow.test.ts`.

**Interfaces:** Adicionar `decision?: AssemblyDecisionContext` a AssemblyDeps, PreparationDeps e deps de proposeScenes. Acrescentar ao módulo novo:

```ts
export function createAssemblyDecisionContext(
  raw: unknown, env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): AssemblyDecisionContext;
```

- [ ] **Step 1: Testar precedência sem chamadas de rede.**

```ts
it.each([
  [null, "1", "key", "hybrid", true],
  [{mode:"off"}, "1", "key", "off", false],
  [{mode:"observe"}, "1", "key", "observe", true],
  [null, undefined, undefined, "off", false],
] as const)("resolve configuração %j", (raw, enabled, key, mode, hasClient) => {
  const context = createAssemblyDecisionContext(raw, {DECUPA_TYPESAFE: enabled, TYPESAFE_API_KEY: key});
  expect(context.mode).toBe(mode);
  expect(Boolean(context.client)).toBe(hasClient);
});
```

Modificar o teste “hybrid TypeSafe não intercepta...” para injetar contexto e uma proposta com candidato elegível, verificando uma chamada útil com texto. Usar fetch simulado; chave dummy. Em preparation.test.ts pausar decide numa Promise, cancelar/alterar revisão e depois resolver: nenhuma proposta antiga deve ser salva.

- [ ] **Step 2: Rodar as suítes citadas e confirmar falhas pelos contratos novos.**

Run: `pnpm vitest run apps/cli/src/app/assembly/{assembly-decisions,preparation,routes,scenes}.test.ts tests/assembly-flow.test.ts --exclude '**/.muse/**'`

- [ ] **Step 3: Passar contexto de ponta a ponta, mantendo a geração atual.**

```ts
const defaultMode = env.DECUPA_TYPESAFE === "1" && env.TYPESAFE_API_KEY ? "hybrid" : "off";
const config = parseDecisionConfig(raw ?? { mode: defaultMode }, env);
const client = config.mode !== "off" && env.DECUPA_TYPESAFE === "1" && env.TYPESAFE_API_KEY
  ? new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, model: config.model, fetchImpl })
  : undefined;
return { mode: config.mode, model: config.model, client };
```

No startAssemblyApp resolver credenciais na mesma precedência de lazyPaidSend (projeto, depois config do usuário), aplicar envWithStoredTypeSafe, ler decision.json distinguindo ENOENT de JSON inválido. Substituir apenas ali o boot descartado pelo contexto acima; não alterar Limpar. Não fazer ping. Passar contexto em prepare, adjust e propose. Dentro do callback validado de requestValidated, separar raw.cutCandidates; resolver e decidir somente depois de validar a proposta, fora do retry de JSON do gerador. Falha do Jev não pode causar uma segunda geração na Z.ai.

Atualizar preparation.note imediatamente antes da decisão para “Jev avaliando cortes”; reaproveitar stage=proposal. Ainda checar signal e isCurrent antes de salvar. Não acrescentar stage inventado só para UI. Operação sem cliente retorna relatório not-run explícito.

- [ ] **Step 4: Reexecutar suítes e verificar zero chamadas reais.**

Run: comando da Step 2 e `pnpm typecheck`. Integração HTTP requer permissão de localhost; falha EPERM exige ajustar ambiente, não remover teste.

- [ ] **Step 5: Commit apenas do encadeamento revisado.**

```bash
git add -p -- apps/cli/src/app/server.ts apps/cli/src/app/assembly tests/assembly-flow.test.ts
git diff --cached --check
git commit -m "feat: wire Jev decisions into montage preparation"
```

### Task 4: Histórico persistido, resultado visível e aceite real

**Files:** Modify/Test `apps/cli/src/app/assembly/{preparation,preparation.test,routes,routes.test}.ts`, `page.js`, `editor/{contexto,rail,sequencia}.js`, `editor/{contexto,rail,sequencia}.test.ts`; extend `tests/assembly-flow.test.ts`.

**Interfaces:** Persistir snapshot pela writeHistorySnapshot(dir, project) existente antes de applyProposal. Acrescentar `undoRevision: number|null` ao envelope GET /project, derivado do snapshot imediatamente anterior realmente existente; não persistir um novo contador. O editor usa essa capacidade para habilitar Desfazer. É uma adição de API explicitamente incluída na revisão deste plano.

- [ ] **Step 1: Testar prepare → snapshot → undo no teste HTTP existente.**

```ts
const snapshot = await readHistorySnapshot(dir, before.project.revision);
expect(snapshot.scenes).toEqual(before.project.scenes);
expect(ready.project.proposal.decisionReport.status).toBe("completed");
expect(ready.undoRevision).toBe(before.project.revision);
```

Inserir essas asserções no fluxo preparar até prévia, usando os nomes locais da fixture (declarar before pelo GET anterior ao POST). Em uma segunda execução sem histórico, assert undoRevision=null; reiniciar o runtime e repetir GET para confirmar persistência. Não executar undo no projeto pessoal.

- [ ] **Step 2: Rodar integração e testes do editor e observar a capacidade ausente.**

Run: `pnpm vitest run tests/assembly-flow.test.ts apps/cli/src/app/assembly/preparation.test.ts apps/cli/src/app/assembly/routes.test.ts apps/cli/src/app/assembly/editor --exclude '**/.muse/**'`

- [ ] **Step 3: Gravar histórico e apresentar informação real.**

```ts
await writeHistorySnapshot(dir, current);
await saveProject(dir, current.revision, p => p.preparation?.id === id ? applyProposal(p, proposal) : p);
```

Fazer a gravação antes da mutação, após checkAlive; erro impede alteração editorial. No GET derivar undoRevision lendo revision-1; ausência retorna null, histórico corrompido retorna erro diagnosticável. Propagar undoRevision ao state pelo call em page.js (incluir esse arquivo na tarefa). O botão não calcula revisão inexistente. Após POST editorial concluído, call em page.js faz um GET adicional para atualizar undoRevision e o catálogo; não repetir esse GET para respostas GET nem para 202, que já usam polling. Não limpar capacidade em respostas parciais: só atualizar quando o campo estiver presente. Montagem antiga sem snapshot continua utilizável e informa que não há alteração disponível para desfazer.

No inspetor mostrar modelo, duração, quantidade de cortes aplicados e candidatos mantidos, modo observe e fallback. Usar textContent. Sem relatório, “Decisão não registrada”; sem candidato, “Sem candidatos elegíveis”. Renomear ação de ajuste para “Aplicar ajuste com IA” e atualizar o teste de casca que fixa o texto. `preparation.note` distingue IA visual, geração e decisão; não exibir tokens/custo inventados.

- [ ] **Step 4: Verificar integração, navegador e piloto sem misturar evidências.**

```bash
pnpm vitest run tests/assembly-flow.test.ts tests/redesign-shell.test.ts apps/cli/src/app/assembly --exclude '**/.muse/**'
pnpm typecheck
pnpm exec oxlint apps/cli/src/app/assembly --deny-warnings
git diff --check
```

Navegador em projeto isolado: clique de Montar com providers simulados; ver status, resultado de decisão, vídeo reproduzindo e Desfazer habilitado; clique Desfazer e confirme cenas restauradas, nova revisão e aprovação invalidada. Cobrir fallback e cancelamento sem modal pago. Para piloto real autorizado, usar cópia isolada de projeto com candidato real revisado; registrar tempos e resposta útil, mantendo originais. Não fabricar candidato para forçar sucesso, não aprovar/exportar o projeto pessoal. A inexistência de material representativo limita o aceite editorial, não os testes offline.

- [ ] **Step 5: Commit revisado e registro de evidências.**

```bash
git add -p -- apps/cli/src/app/assembly tests/assembly-flow.test.ts tests/redesign-shell.test.ts
git diff --cached --check
git commit -m "fix: persist montage undo and show decision results"
```

## Handoff e cobertura

Task 1 cobre briefing; Task 2 contexto, proteção e decisão conservadora; Task 3 ativação/cancelamento e chamada real; Task 4 histórico, interface e aceite. Não implementar b-roll aqui. A próxima entrega é `2026-09-20-montagem-broll.md`. Não há alegação de ganho de desempenho até a medição comparável.

## Evidências de execução — 20/09/2026

- Verificação local integrada: 361 testes em 37 arquivos; typecheck, oxlint e diff-check passaram.
- Navegador em projeto sintético isolado: Montar, relatório Jev, reprodução, posição/duração do apoio, remoção e Desfazer verificados. Corrigida a atualização do estado de prévia que deixava controles desabilitados.
- Falha simulada do Jev: fallback visível, V1/A1 preservados; nenhuma confirmação paga por operação.
- Render real FFmpeg: V1 vermelho em 0,5 s, V2 azul em 2 s, retorno a V1 em 4,5 s; energia da voz em 440 Hz superior a 50 vezes o áudio do apoio em 880 Hz. Mídias originais mantêm os hashes.
- Piloto pago com transcrição de victor.MOV bloqueado pela revisão automática: exige autorização específica do envio textual para Z.ai e TypeSafe. Não houve chamada real nesta execução. Aprovação editorial de b-roll real permanece pendente: projeto disponível contém somente uma fonte de fala incluída e nenhum apoio.
- Interface/API: sem dependências novas e sem alteração do formato version 2; relatório é opcional. Projeto pessoal e WIP anterior preservados no checkout original durante a implementação.

Revisão independente (gpt-6-astra) concluída: dois achados importantes corrigidos com regressões RED→GREEN (apoio do gerador sem Jev; ajuste truncando apoio manual). Seleção de grupo na V2 também reproduzida e corrigida no navegador: selecionar/remover o primeiro grupo preserva o segundo. Cancelamento durante escolha de apoio preserva a montagem anterior. Nova suíte integrada: 361/361; typecheck e oxlint limpos. Sem achados menores adiados.
