# Templates editoriais adaptáveis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar biblioteca local de receitas aprovadas pelo usuário e aplicá-las como propostas revisáveis.

**Architecture:** Separar armazenamento/análise da referência do projeto de edição. Aplicação usa proposeScenes, validação e histórico existentes; entrega usa o plano de Resolve, sem outro motor de montagem.

**Tech Stack:** TypeScript, Node.js >=22.6, Python stdlib, HTML/CSS/JavaScript existentes, pnpm 10.32.1 e Vitest. Sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-09-21-templates-e-entrega-davinci-design.md` (aprovada pelo usuário em 2026-09-21).

## Global Constraints

- Aplicação gera proposta revisável. A prévia continua no Decupa antes da aprovação e entrega.
- Análise gera rascunho editável. Apenas aprovação explícita do usuário libera uma revisão para uso; a IA nunca aprova.
- Entrega padrão: criar e salvar projeto nativo no Resolve, inicialmente importando a timeline existente automaticamente. Exportar `.drp` é uma opção.
- Montagem direta de clipes pela API fica fora desta primeira implementação; considerar apenas diante de limitações comprovadas da importação.
- Animações não executadas são pendências visíveis, com marcadores e handoff para execução no Resolve ou After Effects.
- Chamadas pagas continuam sujeitas a autorização específica; o desenho não as executa nem autoriza por si só.
- Preservar WIP, projetos Resolve e mídia original. Não executar scripts de prova que apagam projetos contra trabalhos do usuário.
- Fixtures e transportes simulados devem impedir rede paga e escrita na biblioteca real durante testes.

## Ordem e mapa de arquivos

Executar após `2026-09-21-entrega-nativa-davinci.md`. A biblioteca em `apps/cli/src/app/templates/` tem tipos, store, análise e rotas próprias; interface é HTML/JS/CSS simples. A integração editorial fica em assembly. Dados novos vivem em `~/.decupa/templates/<uuid>/`, com raiz injetada em testes. server.ts obtém a raiz do diretório de configuração local existente, sem misturar dados com credenciais.

## Review Focus

- Aprovação simultânea com edição/reanálise: conflito de revisão impede publicar conteúdo não visto (tarefa 1).
- Referência movida ou substituída por outro arquivo: religação exige mesmo hash (tarefa 2).
- Vídeo sem áudio, cauda fracionária e movimentos entre frames: cobertura explícita, sem falsa precisão (tarefa 2).
- Texto da referência contém comandos/HTML: tratado como dado e exibido por textContent (tarefas 2–3).
- Aplicação concorrente com edição e undo: proposta rejeitada como stale, snapshot aprovado permanece imutável (tarefa 4).

---
### Task 1: Persistir receitas com aprovação explícita

**Files:** Criar `apps/cli/src/app/templates/types.ts`, `store.ts` e `store.test.ts`.

**Interfaces:** Definir Recipe `{id:string, revision:number, name:string, status:"draft"|"approved", source:{path:string,sha256:string,durationSeconds:number}, analysis:{status:"pending"|"running"|"ready"|"error"|"cancelled",stage:string,error?:string}, rules:Rule[]}`. Rule `{id:string,category:"narrative"|"speech"|"broll"|"rhythm"|"format"|"duration"|"animation", observation:string,instruction:string,enabled:boolean,confidence:"observed"|"uncertain"|"unavailable",evidence:{start:number,end:number}[]}`. Exportar `validateRecipe(raw:unknown):Recipe`, `approveRecipe(recipe:Recipe,expectedRevision:number):Recipe`, `saveRecipe(root:string,recipe:Recipe,expectedRevision:number|null):Promise<void>`, `loadRecipe(root:string,id:string,revision?:number):Promise<Recipe>`, `listRecipes(root:string):Promise<Recipe[]>`. Edição incrementa revisão e volta a draft; revisões aprovadas são imutáveis.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
import { expect,it } from "vitest";
import { approveRecipe } from "./store.ts";
import type { Recipe } from "./types.ts";
const draft:Recipe={id:"11111111-1111-4111-8111-111111111111",revision:1,name:"Evento",status:"draft",source:{path:"/tmp/base.mp4",sha256:"a".repeat(64),durationSeconds:2},analysis:{status:"pending",stage:"media"},rules:[]};
it("análise incompleta não pode ser aprovada",()=>{
  expect(()=>approveRecipe(draft,1)).toThrow(/análise/);
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/templates/store.test.ts
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```typescript
if (recipe.revision !== expectedRevision) throw new Error("revisão desatualizada");
if (recipe.analysis.status !== "ready") throw new Error("análise incompleta");
return {...recipe, status: "approved"};
```
Validar antes de aprovar: UUID, inteiros positivos, hashes, valores finitos, start>=0/end<=duration, start<end, enums, strings limitadas e IDs únicos. Guardar `revisions/<revision>.json` e índice por template; usar publishAtomic e lock com CAS de revisão, sem sobrescrever aprovação anterior. Rascunho editado pode ser salvo; análise não chama approveRecipe. Listagem expõe última aprovada e rascunho corrente; seleção carrega revisão aprovada explicitamente. Acrescentar testes de concorrência, path traversal, edição preservando revisão aprovada e falha de escrita atômica em tmpdir.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** nenhuma aprovação implícita; biblioteca real não é acessada; revisões aprovadas são imutáveis.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: persistir receitas com aprovação explícita"`; não incluir WIP de terceiros.

### Task 2: Analisar referência com evidências e retomada

**Files:** Criar `apps/cli/src/app/templates/analysis.ts` e `analysis.test.ts`; reutilizar `assembly/analysis.ts`, `model.ts`, `frames.ts`, `model-response.ts` e `packages/media`.

**Interfaces:** Exportar `analyzeRecipe(recipe:Recipe,deps:RecipeAnalysisDeps,signal:AbortSignal):Promise<Recipe>`. RecipeAnalysisDeps `{exec:Executor,send:(content:unknown[],signal?:AbortSignal)=>Promise<string>,modelKey:string,allowModel:boolean,allowVisual:boolean,persist:(recipe:Recipe)=>Promise<void>}`. Exportar `relinkRecipe(recipe:Recipe,path:string):Promise<Recipe>` e `validateRules(raw:unknown,durationSeconds:number):Rule[]`. Análise retorna sempre draft e ready apenas quando todas as etapas concluídas ou legitimamente indisponíveis.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
import {expect,it} from "vitest";
import {validateRules} from "./analysis.ts";
it("recusa evidência fora do vídeo",()=>{
 expect(()=>validateRules([{id:"r",category:"rhythm",observation:"corte",instruction:"ritmo rápido",enabled:true,confidence:"observed",evidence:[{start:1,end:3}]}],2)).toThrow();
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/templates/analysis.test.ts
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```typescript
if (!deps.allowModel || !deps.allowVisual) throw new Error("análise externa não autorizada");
const next = {...recipe, status: "draft" as const};
```
Validar mídia antes da chamada; reutilizar transcrição e descrição visual existentes, isolando trabalho/caches na pasta do template e usando AbortSignal. Para vídeo sem áudio, transcrição é legitimamente indisponível. Persistir status, etapa, erro e resultados parciais; cache considera hash da referência, versão de prompt/analisador e modelKey. Reinício transforma running interrompido em estado recuperável; reanálise cria nova revisão, sem alterar aprovada.

Síntese recebe evidências timestampadas, transcrição e metadados. Prompt exige as sete categorias, diferencia observação/instrução, não copia comandos da referência e proíbe tempos fora da mídia. Categorias sem evidência podem ter regra unavailable explicativa, nunca afirmação observada. Amostragem visual de 1fps não mede cortes ou animações exatos: marcar estimativas uncertain e exibir limitação. Não chamar média exata a estimativa amostrada; não adicionar detector novo nesta versão. Processar cauda fracionária e registrar intervalos não observados. Validar JSON por requestValidated e validateRules; falha não publica recipe ready.

Religação compara hashFile(path) com source.sha256 antes de mudar caminho; leitura da receita permanece possível sem mídia. Acrescentar testes com transportes falsos: zero chamadas sem consentimento, abort preserva parcial, JSON inválido, cauda 2.4s, vídeo mudo, instrução maliciosa tratada como texto, cache muda com modelKey e hash diferente recusa religação.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** análise não aprova; cobertura e incerteza são explícitas; retomada não repete resultados válidos nem faz chamadas reais.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: analisar referência com evidências e retomada"`; não incluir WIP de terceiros.

### Task 3: Disponibilizar seção Templates

**Files:** Criar `apps/cli/src/app/templates/routes.ts`, `routes.test.ts`, `page.html`, `page.js`, `page.css`; modificar `apps/cli/src/app/server.ts` e `assembly/page.html` para navegação.

**Interfaces:** Exportar `createTemplateRuntime(root:string,deps:RecipeAnalysisDeps)` com `handleTemplates(req:IncomingMessage,res:ServerResponse):Promise<boolean>`. GET /templates serve interface; GET /templates/api lista receitas; POST /templates/api importa arquivo selecionado pelo mecanismo local existente; GET /templates/api/:id?revision=N lê; PATCH salva draft com baseRevision; POST /:id/analyze, /cancel, /approve, /relink; GET /:id/media serve referência com Range. Rotas seguem as mesmas proteções de origem, corpo e paths das rotas de assembly.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
// Em routes.test.ts, com servidor/requests do harness existente:
it("somente ação approve publica receita", async () => {
  const {approveRecipe}=await import("./store.ts");
  const recipe = {id:"11111111-1111-4111-8111-111111111111",revision:2,name:"Evento",status:"draft" as const,source:{path:"/tmp/base.mp4",sha256:"a".repeat(64),durationSeconds:2},analysis:{status:"ready" as const,stage:"complete"},rules:[]};
  expect(()=>approveRecipe(recipe,1)).toThrow(/revisão/);
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/templates/routes.test.ts
pnpm typecheck
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```javascript
const instruction = document.createElement("textarea");
instruction.value = rule.instruction;
const observation = document.createElement("p");
observation.textContent = rule.observation;
```
Construir biblioteca com estados rascunho/aprovado, formulário de nome e vídeo, progresso/cancelamento/retry, player da referência e linhas de orientações com evidências clicáveis, edição e ativação. Aprovar exige clique dedicado na revisão vista; rota usa CAS e nunca aceita status approved via PATCH. Não servir paths arbitrários: resolver mídia apenas pela receita e validar identidade. Limitar ações à origem local existente; status 409 para stale e 402 para chamadas não autorizadas antes de iniciar trabalho. Consentimento de análise não equivale a aprovação editorial.

Injetar root temporário, exec e send falsos em testes HTTP reais do runtime: PATCH tentando approved, origem estranha, ID inválido, body grande, Range, erro de mídia e análise/cancel. O teste inicial acima deve ser acompanhado desses testes do endpoint; usar receitas válidas para verificar o comportamento de aprovação. Conferir teclado, foco após salvar e região de progresso aria-live no navegador. Nome ou observação com `<img onerror>` deve ser texto inerte.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** biblioteca pode criar, analisar com transporte simulado, revisar e aprovar sem projeto de edição; referência segue consultável.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: disponibilizar seção templates"`; não incluir WIP de terceiros.

### Task 4: Aplicar receita como proposta preservando histórico

**Files:** Modificar `apps/cli/src/app/assembly/types.ts`, `store.ts`, `scenes.ts`, `revisions.ts`, `preparation.ts`, `routes.ts`, `editor/contexto.js`, `editor/api.js` e respectivos testes existentes.

**Interfaces:** Adicionar `Project.template?:Recipe|null` e `Proposal.template?:Recipe|null`; snapshot de Recipe approved, sem leitura dinâmica da biblioteca. Proposal recebe `templateReport?:{ruleId:string,status:"applied"|"adapted"|"unavailable",reason:string}[]`. Importar Recipe de `../templates/types.ts` em types.ts e scenes.ts. Estender deps de proposeScenes com `template?:Recipe|null`; undefined preserva template atual, null remove na próxima proposta. Histórico deve carregar/restaurar template. Proposta candidata fica em arquivo separado `template-proposal.json` com baseRevision, nunca em assembly até aceite explícito.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
// Em scenes.test.ts, reutilizar project() existente:
it("gerar proposta não altera projeto de entrada", async () => {
 const p=project();
 const before=structuredClone(p);
 await expect(proposeScenes(p,"aplicar receita",new AbortController().signal,
   {send:async()=>{throw new Error("transporte simulado");}})).rejects.toThrow();
 expect(p).toEqual(before);
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/assembly/scenes.test.ts apps/cli/src/app/assembly/store.test.ts apps/cli/src/app/assembly/revisions.test.ts apps/cli/src/app/assembly/preparation.test.ts apps/cli/src/app/assembly/routes.test.ts apps/cli/src/app/assembly/editor/contexto.test.ts apps/cli/src/app/assembly/editor/api.test.ts
pnpm typecheck
git diff --check
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```typescript
const selected = deps?.template === undefined ? project.template : deps.template;
if (selected && selected.status !== "approved") throw new Error("template não aprovado");
const recipeSnapshot = selected ? structuredClone(selected) : null;
```
Acrescentar recipeSnapshot ao contexto de proposta, nunca aos catálogos de mídia. Modelo orienta narrativa, falas, B-roll e ritmo sem copiar conteúdo; IDs e takes passam pelos validadores atuais. Validar templateReport contra rules enabled, com um resultado por regra; ausências ou IDs inventados são resposta inválida. Animações viram Scene.animationNotes do plano de entrega, validadas e associadas a cenas reais. Falta de apoio opcional aparece como adaptação; ausência de mídia necessária continua gap bloqueante. Não apagar gaps para habilitar aprovação.

POST /assembly/template-proposal recebe templateId/revision ou null e baseRevision, carrega versão aprovada e respeita consentimento. Grava candidata separada após verificar base; aceitar via rota explícita chama writeHistorySnapshot e applyProposal; rejeitar descarta somente a candidata. Preparação não pode aplicar automaticamente esta proposta: preservar automação atual para montagem normal, mas caminho de aplicação/troca de template exige revisão. A aceitação grava template snapshot, invalida preview/finalApproved e mantém histórico anterior. Estender mergeProjectCommit, validateProject, snapshots e applyHistorySnapshot para não perder template. Defaults ausentes=null preservam projetos version 2; não migração destrutiva.

Na interface, seletor opcional de revisão aprovada e Sem template; botão Gerar proposta; relatório de adaptações, aceitar/rejeitar, animações na revisão. Modelo não recebe autoridade para aprovar. Acrescentar testes: edição da biblioteca não muda snapshot, proposta com ID de fonte da referência é recusada, stale não aplica, undo restaura template, sem template mantém comportamento e animações seguem ao handoff após mover cena.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** proposta é revisável antes de substituir montagem; histórico e prévia permanecem coerentes.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: aplicar receita como proposta preservando histórico"`; não incluir WIP de terceiros.

## Aceitação final e revisão do conjunto

- [ ] Rodar os comandos focados dos dois planos após a integração; repetir apenas suites afetadas por correções. Registrar resultados e revisar todo diff contra a especificação.
- [ ] No navegador, criar um template com vídeo curto autorizado, analisar, revisar e aprovar; se análise exigir chamada paga não autorizada, validar integração com transporte simulado e registrar a aceitação real pendente, sem chamar provedor.
- [ ] Aplicar a dois projetos com quantidades diferentes de falas; revisar adaptações, aceitar, assistir à prévia e aprovar. Conferir material original e sentido das falas manualmente.
- [ ] Entregar a montagem com template ao Resolve e reabrir DRP; conferir notas, cortes, sincronismo e mídias. Comparar com evidência sem template do plano anterior. Registrar em `docs/evidence/2026-09-21-templates-editoriais.md` com revisão, versão Resolve, caminhos e limitações.
- [ ] Fazer revisão independente do conjunto conforme método escolhido pelo usuário; corrigir achados relevantes e repetir checks afetados. Não declarar aceitação visual a partir de testes simulados.

## Revisão deste plano

Cobertura: biblioteca/validação (1, 3); análise/cancelamento/religação (2, 3); aplicação/snapshot/undo/prévia (4); entrega/handoff (plano anterior); aceitação real (seção acima). Persistência é aditiva e inclui defaults legados. Aprovação humana e aprovação de execução permanecem etapas distintas.
