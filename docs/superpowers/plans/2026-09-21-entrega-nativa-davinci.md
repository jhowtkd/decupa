# Entrega nativa no DaVinci Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar qualquer montagem aprovada como projeto permanente no Resolve, preservando prévia e alternativa OTIO.

**Architecture:** Manter exportApproved como autoridade da revisão. Uma ponte Python importa o OTIO já produzido; um coordenador TypeScript registra a operação e a interface torna esse destino padrão.

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

Este plano funciona sozinho, inclusive sem templates. Executar antes de `2026-09-21-templates-editoriais.md`. Arquivos novos ficam próximos à responsabilidade: `assembly/delivery.ts` coordena a entrega; `scripts/davinci-delivery.py` contém somente a integração Resolve; `assembly/handoff.ts` projeta pendências na timeline. O script `davinci-proof.py` permanece prova efêmera, não vira entrega.

## Review Focus

- Resolve já tem projeto com mesmo nome ou edições não salvas: não sobrescrever nem salvar projeto alheio (tarefa 2).
- Processo morre após criar projeto: registrar nome antes de importar; tentativa seguinte não duplica silenciosamente (tarefas 2–3).
- FPS fracionário e início de timeline diferente de zero: comparar posições relativas e intervalos exclusivos corretamente (tarefa 2).
- Clipe de cena movido ou apagado: handoff acompanha a revisão, sem marcador órfão (tarefa 1).
- Projeto muda durante entrega: resultado permanece associado à revisão antiga, sem virar sucesso da revisão atual (tarefa 3).

---
### Task 1: Projetar handoff da revisão aprovada

**Files:** Criar `apps/cli/src/app/assembly/handoff.ts` e `handoff.test.ts`; modificar `types.ts`, `store.ts`, `revisions.ts` e seus testes na mesma pasta.

**Interfaces:** Adicionar `Scene.animationNotes?: {id:string; description:string; destination:"Resolve"|"After Effects"; reference?:{templateId:string; revision:number; start:number; end:number}}[]`. Campos ausentes equivalem a lista vazia. Exportar `buildHandoff(project: Project): HandoffItem[]` de handoff.ts; `HandoffItem` contém id, sceneId, startFrame, durationFrames, description, destination e reference opcional. Os tempos são derivados dos clipes atuais da cena, não persistidos como tempos absolutos antigos.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
import { expect, it } from "vitest";
import { buildHandoff } from "./handoff.ts";
import { blankProject } from "./routes.ts";
it("projeto sem cenas não cria pendências", () => {
  expect(buildHandoff(blankProject("p"))).toEqual([]);
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/assembly/handoff.test.ts apps/cli/src/app/assembly/store.test.ts apps/cli/src/app/assembly/revisions.test.ts
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```typescript
const clips = project.assembly.tracks.flatMap(t => t.clips)
  .filter(c => c.sceneId === scene.id);
const startFrame = Math.min(...clips.map(c => c.startFrame));
const endFrame = Math.max(...clips.map(c => c.startFrame + c.durationFrames));
```
Executar esse cálculo apenas para cenas com notas e clipes; cena com nota e sem clipe é erro editorial acionável. Validar IDs únicos, descrição não vazia e destino permitido. Em store.ts, preservar notas ao carregar, mesclar e restaurar cenas. Não colocar animationNotes em gaps: gaps continua bloqueando aprovação; notas são trabalho explicitamente destinado à finalização. Mostrar as notas antes da aprovação na tarefa 4. Acrescentar testes de cena movida, removida, notas malformadas e preservação após round-trip de armazenamento. Testar que gaps ainda bloqueia approveFinal e notas não bloqueiam prévia válida.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** tempos acompanham os clipes; dados antigos carregam; nenhuma regra de mídia ou aprovação é relaxada.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: projetar handoff da revisão aprovada"`; não incluir WIP de terceiros.

### Task 2: Criar ponte permanente para o Resolve

**Files:** Criar `scripts/davinci-delivery.py` e `scripts/davinci-delivery.test.ts`; ler `scripts/davinci-proof.py` e `scripts/davinci-proof.test.ts` sem copiar sua limpeza destrutiva.

**Interfaces:** Entrada JSON por arquivo: `{operationId, projectId, revision, projectName, otioPath, assembly, handoff, drpPath?}`; assembly usa Assembly e handoff usa HandoffItem[]. Saída JSON por linha: `{stage, projectName?, error?}`; resultado final `{ok, projectName, verified, drpPath?}`. Stages: connecting, created, imported, verified, saved, exported, error. Exportar no módulo Python `deliver(request, resolve, emit)` para teste com stub sem conexão real.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
it("entrada inválida não conecta ao Resolve", () => {
  const r = spawnSync("python3", ["scripts/davinci-delivery.py", "--request", "/inexistente/request.json"], {encoding:"utf8"});
  expect(r.status).not.toBe(0);
  expect(r.stdout).toContain('"ok": false');
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run scripts/davinci-delivery.test.ts
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```python
project = manager.CreateProject(request["projectName"])
if project is None:
    raise RuntimeError("nome de projeto indisponível; criar outra cópia explicitamente")
emit({"stage": "created", "projectName": request["projectName"]})
media_pool = project.GetMediaPool()
timeline = media_pool.ImportTimelineFromFile(request["otioPath"])
if timeline is None:
    raise RuntimeError("falha ao importar timeline")
```
Validar request antes de conectar. Usar módulo oficial instalado e configuração local de scripting; ausência retorna erro acionável. Antes de criar projeto, detectar sessão atual com alterações não salvas quando API suportar; se não puder determinar com segurança, orientar usuário a salvar/fechar o projeto atual antes da entrega. Não salvar projeto alheio automaticamente.

Configurar FPS/resolução antes de importar e verificar retornos de SetSetting. Conferir mídia por identidade/caminho real, contagem por faixa, posições relativas ao início da timeline, source offsets e durações usando FPS racional; ler documentação local para semântica dos getters. Se não houver evidência suficiente para validar um campo, retornar falha de verificação, não sucesso presumido. Organizar bins sem mudar links. Criar marcadores da mesma lista do handoff, conferir AddMarker, SetCurrentTimeline, SaveProject e ExportProject. `.drp` deve existir e ser não vazio. Não chamar DeleteProject. Para repetir sucesso, disponibilizar modo de abrir projeto registrado, sem importar novamente; ausência desse projeto pede nova cópia explícita.

No teste TS, reutilizar o padrão de stub Python de davinci-proof.test.ts e testar deliver diretamente: colisão, falha de importação/salvamento, 24000/1001, start frame 86400, erro de mídia, marcador e exportação falsa. Stub deve falhar se DeleteProject ou SaveProject de outro projeto for chamado. Evento created precede importação e é flushado.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** fluxo completo simulado e erros retornam contrato previsível; zero acesso ao Resolve real.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: criar ponte permanente para o resolve"`; não incluir WIP de terceiros.

### Task 3: Coordenar entrega por revisão

**Files:** Criar `apps/cli/src/app/assembly/delivery.ts` e `delivery.test.ts`; modificar `routes.ts`, `routes.test.ts` e `export.ts` somente para incluir handoff na publicação existente.

**Interfaces:** Exportar `deliverApproved(project:Project, dir:string, exec:Executor, signal:AbortSignal):Promise<DeliveryRecord>`. DeliveryRecord: `{operationId:string, revision:number, assemblySha256:string, status:"running"|"ready"|"error", stage:string, projectName:string, error?:string, drpPath?:string}`. Persistir em `exports/<revision>/resolve-delivery.json`, por gravação atômica; o manifest do export continua validando OTIO/MP4 e acrescenta hash do handoff quando presente. Criar POST `/assembly/deliver-resolve` com baseRevision e GET de status no roteamento existente; ação separada POST para exportar DRP da entrega registrada.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
import { expect, it } from "vitest";
import { deliverApproved } from "./delivery.ts";
import { blankProject } from "./routes.ts";
it("não chama ponte sem aprovação", async () => {
  let calls=0;
  const exec={run:async()=>{calls++; return {code:0,stdout:"",stderr:""};}};
  await expect(deliverApproved(blankProject("p"), "/tmp/unused-delivery", exec, new AbortController().signal)).rejects.toThrow(/aprovação/);
  expect(calls).toBe(0);
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/assembly/delivery.test.ts apps/cli/src/app/assembly/export.test.ts apps/cli/src/app/assembly/routes.test.ts
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```typescript
const dest = await exportApproved(project, dir);
const handoff = buildHandoff(project);
// Escrever request JSON em dest; chamar Python via exec.run com args separados.
```
Guardar handoff JSON e Markdown no pacote atômico do export, incluindo revision e projectId; nunca regenerar o vídeo. Serializar entregas ao Resolve com fila existente de limite 1 e lock de arquivo exclusivo com identificação de processo, pois vários projetos podem ter servidores próprios. Registrar operação antes de invocar a ponte e persistir eventos onLine. Nome inclui nome humano, id curto do projeto, revisão e id curto da operação. Retentativa de sucesso abre projeto registrado; falha parcial oferece nova cópia explicitamente, nunca apaga ou reinicializa a existente. Processo interrompido vira erro recuperável na leitura, preservando nome conhecido. Não manter promessa running após reinício.

Revalidar loadProject após a ponte terminar: entrega de revisão antiga continua no registro antigo, resposta 409 avisa mudança. Rotas seguem validação de origem, limite de corpo e erros existentes. Registrar stderr sem dados sensíveis. DRP usa caminho controlado pelo servidor e associa-se ao nome registrado, não ao projeto atualmente aberto por acaso. Acrescentar testes com exec simulado para concorrência, interrupção depois de created, repetição, revisão trocada e exportação DRP; nenhum subprocesso real nestes testes.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** aprovação/identidade continuam obrigatórias; falhas não perdem a prévia; duas requisições não geram duplicação silenciosa.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: coordenar entrega por revisão"`; não incluir WIP de terceiros.

### Task 4: Apresentar entrega nativa e validar amostra

**Files:** Modificar `apps/cli/src/app/assembly/editor/contexto.js`, `contexto.test.ts`, `state.js`, `state.test.ts`, `api.js`, `api.test.ts`, `page.html`; criar `docs/evidence/2026-09-21-entrega-davinci.md` somente durante execução.

**Interfaces:** Ação principal chama POST deliver-resolve da tarefa 3. Exportação OTIO atual permanece opção secundária explícita; prévia/approve-final mantêm suas rotas. exportView existente recebe estado de entrega e exibe etapa, erro e retry. Handoff usa dados da revisão atual, não HTML vindo do modelo.

- [ ] **1. Acrescentar o teste de regressão abaixo** ao arquivo de teste indicado; reutilizar as fixtures existentes quando mencionadas.

```typescript
// Acrescentar no teste existente do contrato de interface:
it("apresenta Resolve como destino padrão", async () => {
  const {readFile}=await import("node:fs/promises");
  const source=await readFile("apps/cli/src/app/assembly/editor/contexto.js","utf8");
  expect(source).toContain("Abrir montagem no DaVinci");
});
```

- [ ] **2. Executar o teste e confirmar falha pelo comportamento ainda ausente.**

```bash
pnpm exec vitest run apps/cli/src/app/assembly/editor/contexto.test.ts apps/cli/src/app/assembly/editor/state.test.ts apps/cli/src/app/assembly/editor/api.test.ts
pnpm typecheck
git diff --check
```

- [ ] **3. Implementar o contrato mínimo** e os casos descritos a seguir. Código abaixo fixa o núcleo da solução; conectar aos chamadores listados nesta tarefa.

```javascript
exportButton.textContent = "Abrir montagem no DaVinci";
// Textos da receita e do handoff entram via textContent.
```
Atualizar o handler existente, não criar segundo fluxo de aprovação. Mostrar etapas, resultado, opção Exportar .drp, dependência das mídias e alternativa Exportar timeline. Na revisão, listar animações pendentes antes de aprovar. Manter controles de teclado, rótulos e região aria-live para progresso. Ampliar testes de estado e API existentes para unavailable/error/ready/stale; teste textual acima é apenas o início, não prova interação.

No navegador, usar projeto temporário com mídia curta autorizada, falas e B-rolls. Conferir prévia, aprovar, entregar no Resolve, conferir imagem/áudio/cortes, exportar DRP e reabrir em nome único. Entregar revisão seguinte e verificar primeira intacta. Registrar versão/edição Resolve, caminhos, revisão, checks automáticos e observação humana no arquivo de evidência. Se scripting não estiver disponível, registrar bloqueio sem declarar aceitação; não comprar licença nem alterar projeto alheio. A mesma amostra sem template fecha a primeira entrega independente.

- [ ] **4. Executar o mesmo comando, corrigir falhas desta mudança e confirmar:** checks locais passam; evidência real fica separada de simulações, com bloqueios claramente registrados.
- [ ] **5. Revisar o diff e registrar apenas os arquivos desta tarefa em commit local.** Usar `git diff --check`, adicionar explicitamente os caminhos listados acima e `git commit -m "feat: apresentar entrega nativa e validar amostra"`; não incluir WIP de terceiros.


## Revisão deste plano

Cobertura: identidade da revisão/prévia (3), handoff (1), criação e verificação Resolve (2), preservação e repetição (2–3), interface/alternativa OTIO e amostra real (4). As assinaturas de HandoffItem e DeliveryRecord estão definidas nas tarefas produtoras. Nenhum teste foi executado nesta fase documental; os comandos são instruções para a execução aprovada.
