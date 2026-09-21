# Decupa — bancada de montagem (redesign) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompor a interface local do Decupa como bancada de vídeo (prévia central, timeline com espaço, materiais à esquerda, inspetor contextual, texto como ferramenta) sem trocar nenhum motor, endpoint ou contrato.

**Architecture:** As telas locais são HTML servido por servidores Node embutidos no CLI (`apps/cli/src/app/server.ts` serve a montagem; `apps/cli/src/mark-web/server.ts` serve a marcação; limpeza e provider-setup saem de `server.ts`/`provider-setup.ts`). O redesign é markup + CSS + recomposição dos módulos `apps/cli/src/app/assembly/editor/*.js`; nenhum endpoint muda e nenhum framework entra. IDs de mount (`rail`, `texto`, `contexto`, `faixa`, `previewPlayer`, `status`) são preservados e apenas reposicionados; regiões novas (`topbar`, `stages`, `tools`, `center`, `stage`) são aditivas. O `core.js` do protótipo NÃO entra em produção.

**Tech Stack:** Node >= 22.6 com `--experimental-strip-types`, HTML/CSS/JS vanilla sem dependências de execução, vitest, tsc, oxlint, pnpm.

**Spec:** `/Users/jhonatan/Downloads/decupa-redesign/REDESIGN_E_IMPLEMENTACAO.md` (ler antes de executar; o plano argumenta a partir dele). Protótipo de referência (visual apenas, não copiar lógica): `/Users/jhonatan/Downloads/decupa-redesign/decupa-redesign.html`, `app.js`, `styles.css`, `core.js`.

## Global Constraints

Vale para TODAS as tarefas, implicitamente.

### Escopo (decisão de decomposição)

- Este plano cobre as Etapas A–E do spec (§6): base/contratos, bancada, texto/triagem, preparação/entrega, setup/marcação. Cada task entrega software funcionando e testável sobre o backend atual.
- A Etapa F do spec (acesso, projetos, biblioteca, fila, administração centralizada — telas 12–16 do protótipo) é OUTRO subsistema: exige autenticação, autorização, persistência e isolamento de arquivos que não existem. Ela fica para um plano separado e NENHUMA task deste plano cria essas superfícies, mesmo que visualmente.
- Adaptações explícitas do spec para os dados reais (não são cortes de escopo, são honestidade de dados): (a) sem roteador — o `nav#stages` destaca a etapa e rola até a região, pois é página única; (b) histórico como lista de versões com dados reais de revisão, não diálogo; (c) sem atalho "simular reprodução" em nenhum ambiente — teste dedicado (Task 10) falha se a string aparecer em `apps/`.

### Branch e git

- Trabalhe na branch `redesign-bancada` (criada na Task 1 a partir de `main`).
- A árvore pode ter arquivos MODIFICADOS POR OUTRO TRABALHO. NUNCA rode `git add -A` nem `git add .`. Faça stage apenas dos arquivos que a sua task tocou, pelo nome.
- Um commit por task, mensagem convencional em pt-BR (ex.: `feat(ui): shell da bancada de montagem`).

### Verificação (toda task termina com isto verde)

```bash
pnpm vitest run apps/cli/src/app/assembly/editor <arquivo-de-teste-da-task>
pnpm vitest run
pnpm typecheck
pnpm lint
```

- Testes novos de unidade cobrem SOMENTE funções puras (sem DOM — o repo não tem jsdom/happy-dom; NÃO adicionar dependência). Regras de markup/CSS são travadas por testes de contrato que leem o arquivo do disco (`readFile`) e por suítes HTTP existentes (`tests/assembly-*.test.ts`).
- Prova visual (receita única; screenshots em `work/ui-screens/png/`):

```bash
node work/ui-screens/serve.ts &        # limpar 7791 · montar 7792 · marcar 7793
playwright-cli open http://127.0.0.1:7792/
playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T3-montar.png
```

- `page.html`, `page.css` e `editor/*.js` da montagem são lidos no boot e cacheados em memória: depois de editar QUALQUER um deles, **mate e suba o serve.ts de novo** (`kill <pid>`; o pid está em `work/ui-screens/serve.log`).
- Compare cada print com as capturas do protótipo em `/Users/jhonatan/Downloads/decupa-redesign/previews/` (01-editor, 02-transcript, 10-mark etc.).

### Tokens canônicos (valores exatos do spec §4 — colar em cada superfície que a task tocar)

```css
:root {
  --bg: #111214; --panel: #191A1D; --panel2: #202226;
  --line: #303238; --line-strong: #3A414B;
  --ink: #F0F0ED; --muted: #AAADB5;
  --accent: #F0CA6E; --on-accent: #1B1508;
  --green: #9FC9B2; --red: #EFAAA0;
  /* aliases: o page.css atual usa muito estes nomes; manter como alias */
  --bg-0: var(--bg); --bg-1: var(--panel); --bg-2: var(--panel2);
  --ok: var(--green); --warn: var(--red);
  --serif: Charter, "Iowan Old Style", Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans-ui: system-ui, -apple-system, sans-serif;
}
```

### Contratos que NUNCA mudam (spec §5)

- Aprovação exige prévia da revisão atual assistida até o fim; qualquer edição invalida (`apps/cli/src/app/assembly/editor/state.js` + `watched.js` intactos em comportamento).
- Auto-prévia com debounce, `baseRevision`, recusa de resposta obsoleta e reconciliação em 409 (`page.js`: `maybeScheduleAutoPreview`, `scheduleAutoPreview`, `call`) — não tocar na lógica, só no entorno DOM.
- Player único: `player.el()` retorna `#previewPlayer`; `playOriginal`/`seek` inalterados. Assistir ao original NÃO marca assistido.
- Marcação segue às cegas: nada de transcrição, predição ou "melhor posição" em `apps/cli/src/mark-web/page.html`.
- Exportação filtrada por capacidade de cada fluxo; limpeza (EDL/MP4/SRT/TXT) e montagem (inclui OTIO) não ganham formatos novos.
- Onde o backend só cancela, o botão diz "Cancelar preparação" — nunca "Pausar".

---

## File Structure

```
apps/cli/src/app/assembly/
  page.html            # Task 3: novo shell (topbar/stages/tools/center/stage + mounts antigos)
  page.css             # Task 2: tokens; Task 3: grid da bancada + responsivo
  page.js              # Task 3: importa mountStage, fia stages/tools; lógica de negócio intacta
  editor/
    rail.js            # Task 3: remove .rail-head (status vai ao topbar)
                       # Task 4: materiais + diálogos briefing/prep; entrega sai daqui
                       # Task 8: stageLabel + exportView com formatos por capacidade
    contexto.js        # Task 5: preview vira mountStage(#stage); inspetor fica em #contexto
    sequencia.js       # Task 6: régua, timecode, fontes/duração, legendas só com dado real
    texto.js           # Task 7: diffWords (patch cirúrgico) + tema; sem re-render no playhead
    watched.js         # INTOCADO (contrato de aprovação)
    state.js           # INTOCADO (invalidação por revisão)
    baseline.test.ts   # Task 1 (novo): trava aprovação/invalidação em nível puro
    contexto.test.ts   # Task 5 (novo): trava inspectorSections
apps/cli/src/app/
  page.html            # Task 7: limpeza no mesmo sistema visual (só markup/classes)
  provider-setup.html  # Task 9: tema sem mudar validações nem copy de custódia local
apps/cli/src/mark-web/
  page.html            # Task 9: tema + onda hero; zero dado de transcript
tests/
  redesign-theme.test.ts     # Task 2 (novo): contrato dos tokens no page.css
  redesign-shell.test.ts     # Task 3 (novo): contrato das regiões no page.html
  redesign-surfaces.test.ts  # Task 9 (novo): contratos de setup + mark-web
  redesign-contracts.test.ts # Task 10 (novo): fiação cruzada + anti-atalhos
```

IDs de mount (definidos aqui, usados em TODAS as tasks — não renomear sem atualizar Task 10):

| id | região | dono |
|---|---|---|
| `topbar` | barra 56px (marca, projeto, `#status`, Briefing) | `page.html` estático |
| `stages` | etapas 42px (`data-stage`: materiais, edicao, revisao, entrega) | `page.js` |
| `tools` | trilho 62px (`data-tool="texto"`, toggle mostra/oculta `#texto`) | `page.js` |
| `rail` | materiais 260px | `mountRail` |
| `center` | centro (`#stage` + `#texto`) | `page.html` estático |
| `stage` | prévia central | `mountStage` (novo export de `contexto.js`) |
| `texto` | ferramenta de texto (visível por padrão) | `mountTexto` |
| `contexto` | inspetor 272px (correções, ajuste, entrega) | `mountContexto` |
| `faixa` | timeline 266px | `mountSequencia` |
| `previewPlayer` | único `<video>` (muda de `#contexto` para `#stage` na Task 5) | `player.el()` |
| `status` | texto único de estado (sai do `.rail-head`, vai ao `#topbar` na Task 3) | `page.js renderStatus` |
| `delivery` | seção de entrega dentro do inspetor (criada na Task 8) | `mountContexto` |
| `briefingDialog`, `prepDialog` | `<dialog>` nativos (criados na Task 4) | `mountRail` |

---

### Task 1: Linha de base — travar os contratos antes de tocar no layout (Etapa A)

**Files:**
- Create: `apps/cli/src/app/assembly/editor/baseline.test.ts`
- Modify: nenhum arquivo de produção

**Interfaces:**
- Consumes: `watchedState(project, watched)` de `./watched.js`; `createState(initial)` de `./state.js`
- Produces: nada (só teste; tasks seguintes dependem destes contratos estarem verdes)

- [ ] **Step 1: Criar a branch e escrever o teste de contrato**

```bash
git checkout -b redesign-bancada
```

```ts
// apps/cli/src/app/assembly/editor/baseline.test.ts
import { expect, it } from "vitest";
import { watchedState } from "./watched.js";
import { createState } from "./state.js";

function project(over: Record<string, unknown> = {}) {
  return { revision: 5, previewRevision: 5, ...over };
}

it("aprovação exige prévia atual assistida até o fim", () => {
  expect(watchedState(project(), { revision: 5, ended: true }).canApprove).toBe(true);
  expect(watchedState(project(), { revision: 5, ended: false }).canApprove).toBe(false);
  expect(watchedState(project(), { revision: 4, ended: true }).canApprove).toBe(false);
});

it("sem prévia ou prévia obsoleta: bloqueia com rótulo próprio", () => {
  expect(watchedState(project({ previewRevision: null }), { revision: 5, ended: true }))
    .toMatchObject({ fresh: false, canApprove: false, label: "renderizando…" });
  expect(watchedState(project({ revision: 6 }), { revision: 5, ended: true }))
    .toMatchObject({ fresh: false, canApprove: false });
});

it("nova revisão invalida o assistido no state", () => {
  const state = createState({ project: project(), watched: { revision: 5, ended: true } });
  state.set("project", project({ revision: 6, previewRevision: 5 }));
  expect(state.get("watched")).toEqual({ revision: null, ended: false });
});
```

- [ ] **Step 2: Rodar o teste novo**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/baseline.test.ts`
Expected: 3 passed (é trava de regressão sobre comportamento existente, não TDD clássico).

- [ ] **Step 3: Rodar a suíte inteira e registrar a base**

Run: `pnpm vitest run` e depois `pnpm typecheck && pnpm lint`
Expected: tudo verde; anotar no corpo do commit quantos testes passaram (ex.: "base: 214 passed").

- [ ] **Step 4: Capturar prints da base (prova visual do antes)**

```bash
node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T1-base-montar.png
playwright-cli open http://127.0.0.1:7791/ && playwright-cli screenshot --filename=png/redesign-T1-base-limpar.png
playwright-cli open http://127.0.0.1:7793/ && playwright-cli screenshot --filename=png/redesign-T1-base-marcar.png
```

Expected: 3 PNGs em `work/ui-screens/png/` mostrando o layout atual (texto-centrado).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/assembly/editor/baseline.test.ts
git commit -m "test(ui): trava contratos de aprovação antes do redesign da bancada"
```

---

### Task 2: Tokens grafite/dourado-fosco no `page.css` (fundação visual)

**Files:**
- Create: `tests/redesign-theme.test.ts`
- Modify: `apps/cli/src/app/assembly/page.css` (bloco `:root`, linhas 2–13)

**Interfaces:**
- Consumes: nada
- Produces: tokens `--bg/--panel/--panel2/--line/--ink/--muted/--accent/--green/--red` + aliases `--bg-0/--bg-1/--bg-2/--ok/--warn` usados pelas Tasks 3–8

- [ ] **Step 1: Escrever o teste de contrato dos tokens (falha antes)**

```ts
// tests/redesign-theme.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const CSS_URL = new URL("../apps/cli/src/app/assembly/page.css", import.meta.url);

it("page.css usa os tokens grafite/dourado-fosco do redesign", async () => {
  const css = await readFile(CSS_URL, "utf8");
  for (const token of [
    "--bg: #111214",
    "--panel: #191A1D",
    "--panel2: #202226",
    "--line: #303238",
    "--ink: #F0F0ED",
    "--muted: #AAADB5",
    "--accent: #F0CA6E",
    "--green: #9FC9B2",
    "--red: #EFAAA0",
  ]) {
    expect(css).toContain(token);
  }
});

it("aliases antigos continuam resolvendo (sem var órfã)", async () => {
  const css = await readFile(CSS_URL, "utf8");
  for (const alias of ["--bg-0: var(--bg)", "--bg-1: var(--panel)", "--bg-2: var(--panel2)", "--ok: var(--green)", "--warn: var(--red)"]) {
    expect(css).toContain(alias);
  }
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run tests/redesign-theme.test.ts`
Expected: FAIL — `expected ... to contain '--bg: #111214'`.

- [ ] **Step 3: Trocar o bloco `:root` (somente ele; zero regra de layout aqui)**

Substituir as linhas 2–13 de `apps/cli/src/app/assembly/page.css` por:

```css
:root {
  --bg: #111214; --panel: #191A1D; --panel2: #202226;
  --line: #303238; --line-strong: #3A414B;
  --ink: #F0F0ED; --muted: #AAADB5; --faint: #7d8590;
  --accent: #F0CA6E; --on-accent: #1B1508;
  --green: #9FC9B2; --red: #EFAAA0;
  --bg-0: var(--bg); --bg-1: var(--panel); --bg-2: var(--panel2);
  --ok: var(--green); --warn: var(--red);
  --removed: #3a2a26; --protected: #5b84b8;
  --serif: Charter, "Iowan Old Style", Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans-ui: system-ui, -apple-system, sans-serif;
}
```

- [ ] **Step 4: Rodar teste + suíte afetada**

Run: `pnpm vitest run tests/redesign-theme.test.ts apps/cli/src/app/assembly/editor`
Expected: PASS em todos (nenhum teste de comportamento quebra com troca de token).

- [ ] **Step 5: Prova visual + verificações**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T2-montar.png
```

Expected: mesmo layout da base, com fundo grafite `#111214` e acento dourado-fosco. `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add tests/redesign-theme.test.ts apps/cli/src/app/assembly/page.css
git commit -m "feat(ui): tokens grafite/dourado-fosco na montagem"
```

---

### Task 3: Shell da bancada — topbar, etapas, ferramentas, centro, timeline (Etapa B/1)

**Files:**
- Create: `tests/redesign-shell.test.ts`
- Modify: `apps/cli/src/app/assembly/page.html` (reescrita do `body`, ~30 linhas)
- Modify: `apps/cli/src/app/assembly/page.css` (grid do `body` + regras `#topbar/#stages/#tools/#center/#stage` + responsivo)
- Modify: `apps/cli/src/app/assembly/page.js` (import `mountStage`; fiação de `stages`/`tools`; mounts — linhas 4–9, 324–327)
- Modify: `apps/cli/src/app/assembly/editor/rail.js` (remover bloco `.rail-head` que criava `#status`, linhas 76–87)

**Interfaces:**
- Consumes: `mountRail/mountContexto/mountTexto/mountSequencia` (assinaturas inalteradas); `mountStage({state, api, player})` (novo export de `contexto.js` — a Task 3 o importa, a Task 5 o implementa; ATENÇÃO à ordem: esta task cria um `mountStage` temporário mínimo dentro de `contexto.js` que só ancora `#stage`, e a Task 5 o expande — ver Step 3c)
- Produces: regiões `#topbar/#stages/#tools/#rail/#center/#stage/#texto/#contexto/#faixa`; mapa `STAGE_TARGET = {materiais: "rail", edicao: "center", revisao: "stage", entrega: "delivery"}`; toggle `data-tool="texto"`

- [ ] **Step 1: Escrever o teste de contrato do shell (falha antes)**

```ts
// tests/redesign-shell.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const HTML_URL = new URL("../apps/cli/src/app/assembly/page.html", import.meta.url);
const JS_URL = new URL("../apps/cli/src/app/assembly/page.js", import.meta.url);

it("page.html tem as regiões da bancada e preserva os mounts", async () => {
  const html = await readFile(HTML_URL, "utf8");
  for (const id of ["topbar", "stages", "tools", "rail", "center", "stage", "texto", "contexto", "faixa", "status", "previewPlayer", "dropzone", "filePicker"]) {
    expect(html).toContain(`id="${id}"`);
  }
  for (const stage of ["materiais", "edicao", "revisao", "entrega"]) {
    expect(html).toContain(`data-stage="${stage}"`);
  }
  expect(html).toContain('data-tool="texto"');
});

it("page.js monta as cinco regiões e fia stages/tools", async () => {
  const js = await readFile(JS_URL, "utf8");
  for (const call of ["mountRail({ state, api, player })", "mountContexto({ state, api, player })", "mountTexto({ state, api, player })", "mountSequencia({ state, api, player })", "mountStage({ state, api, player })"]) {
    expect(js).toContain(call);
  }
  expect(js).toContain("STAGE_TARGET");
  expect(js).toContain('data-tool="texto"');
});
```

Nota: o teste exige `id="previewPlayer"` no HTML estático. Hoje o `<video>` é criado pelo `mountContexto`; nesta task ele passa a existir no markup de `#stage` (o player continua único; `player.el()` não muda). A Task 5 move a LÓGICA de watched/aprovação para `mountStage` sem recriar o elemento.

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run tests/redesign-shell.test.ts`
Expected: FAIL em `id="topbar"`.

- [ ] **Step 3a: Reescrever o `body` do `page.html`**

Conteúdo completo do arquivo (31 linhas):

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>decupa · montagem</title>
<link rel="stylesheet" href="/page.css">
</head>
<body>
<header id="topbar" aria-label="Projeto">
  <strong class="brand">decupa</strong>
  <span id="projectName" class="muted">montagem</span>
  <span id="status" role="status" aria-live="polite">carregando…</span>
  <span class="spacer"></span>
  <button type="button" id="openBriefing">Briefing</button>
</header>
<nav id="stages" aria-label="Etapas">
  <button type="button" data-stage="materiais" aria-current="true">Materiais</button>
  <button type="button" data-stage="edicao">Edição</button>
  <button type="button" data-stage="revisao">Revisão</button>
  <button type="button" data-stage="entrega">Entrega</button>
</nav>
<div id="tools" role="toolbar" aria-label="Ferramentas">
  <button type="button" data-tool="texto" aria-pressed="true" title="Mostrar/ocultar texto">Texto</button>
</div>
<aside id="rail" aria-label="Materiais"></aside>
<main id="center" aria-label="Bancada">
  <section id="stage" aria-label="Prévia">
    <video id="previewPlayer" controls preload="metadata"></video>
  </section>
  <section id="texto" aria-label="Texto"></section>
</main>
<aside id="contexto" aria-label="Inspetor"></aside>
<footer id="faixa" aria-label="Sequência"></footer>
<div id="dropzone" hidden tabindex="0" role="button" aria-label="Enviar arquivos de mídia">
  Arraste arquivos para cá ou clique para escolher
  <input type="file" id="filePicker" accept="video/*,audio/*" multiple hidden>
</div>
<script type="module" src="/page.js"></script>
</body>
</html>
```

O guia vazio ("Monte seu vídeo em 3 passos") sai do HTML estático: o `mountTexto` já renderiza estado vazio quando `sources` é vazio — confirmar no print do Step 5 que importar continua possível pelo botão `#select` do rail.

- [ ] **Step 3b: Grid da bancada + responsivo no `page.css`**

Substituir a regra `body` (linhas 15–20) por:

```css
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  display: grid; height: 100dvh;
  grid-template:
    "topbar topbar topbar topbar" 56px
    "stages stages stages stages" 42px
    "tools rail center inspector" 1fr
    "timeline timeline timeline timeline" 266px
  / 62px 260px 1fr 272px;
}
#topbar { grid-area: topbar; display: flex; align-items: center; gap: 12px; padding: 0 14px;
  background: var(--panel); border-bottom: 1px solid var(--line); font-size: 13px; }
#topbar .brand { font-size: 15px; }
#topbar .spacer { flex: 1; }
#stages { grid-area: stages; display: flex; align-items: center; gap: 4px; padding: 0 14px;
  background: var(--panel); border-bottom: 1px solid var(--line); }
#stages [data-stage][aria-current="true"] { border-color: var(--accent); color: var(--accent); }
#tools { grid-area: tools; display: flex; flex-direction: column; gap: 8px; padding: 12px 8px;
  background: var(--panel); border-right: 1px solid var(--line); }
#tools [data-tool] { writing-mode: horizontal-tb; padding: 0 4px; font-size: 12px; }
#rail { grid-area: rail; overflow-y: auto; background: var(--panel); border-right: 1px solid var(--line); padding: 14px 12px 40px; font-size: 13px; }
#center { grid-area: center; overflow-y: auto; display: flex; flex-direction: column; gap: 0; min-width: 0; }
#stage { padding: 16px 16px 8px; }
#stage video { max-height: 46vh; }
#texto { padding: 8px 28px 120px; max-width: 56rem; }
#contexto { grid-area: inspector; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--line); padding: 14px 12px 40px; font-size: 13px; }
#faixa { grid-area: timeline; border-top: 1px solid var(--line); background: var(--panel);
  height: 266px; overflow-y: auto; padding: 8px 14px; }
@media (max-width: 1100px) {
  body { grid-template:
    "topbar topbar topbar" 56px
    "stages stages stages" 42px
    "tools rail center" 1fr
    "timeline timeline timeline" 266px
  / 62px 240px 1fr; }
  #contexto { position: fixed; right: 0; top: 98px; bottom: 266px; width: min(320px, 90vw);
    z-index: 5; box-shadow: -8px 0 24px rgb(0 0 0 / .4); }
  #contexto[hidden] { display: none; }
}
@media (max-width: 700px) {
  body { display: flex; flex-direction: column; height: 100dvh; }
  #tools { flex-direction: row; border-right: none; border-bottom: 1px solid var(--line); }
  #rail, #center, #faixa { border: none; border-bottom: 1px solid var(--line); }
  #faixa { height: auto; max-height: 40vh; }
  #contexto { top: auto; bottom: 0; max-height: 70vh; }
}
```

E remover a regra antiga `#texto { grid-area: texto; ... }` (linha 23) — o `#texto` agora é filho de `#center`.

- [ ] **Step 3c: Fiação no `page.js` + âncora mínima de `mountStage`**

Em `page.js`, trocar o bloco de imports (linhas 4–9):

```js
import { createState } from "/editor/state.js";
import { createApi } from "/editor/api.js";
import { mountRail } from "/editor/rail.js";
import { mountContexto, mountStage } from "/editor/contexto.js";
import { mountTexto } from "/editor/texto.js";
import { mountSequencia } from "/editor/sequencia.js";
```

Trocar o bloco de mounts (linhas 324–327) por:

```js
mountStage({ state, api, player });
mountContexto({ state, api, player });
mountRail({ state, api, player });
mountTexto({ state, api, player });
mountSequencia({ state, api, player });

const STAGE_TARGET = { materiais: "rail", edicao: "center", revisao: "stage", entrega: "delivery" };
document.getElementById("stages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-stage]");
  if (!button) return;
  for (const el of document.querySelectorAll("#stages [data-stage]")) el.removeAttribute("aria-current");
  button.setAttribute("aria-current", "true");
  document.getElementById(STAGE_TARGET[button.dataset.stage])?.scrollIntoView({ block: "nearest" });
});
const toolTexto = document.querySelector('[data-tool="texto"]');
toolTexto.addEventListener("click", () => {
  const texto = document.getElementById("texto");
  const show = texto.hasAttribute("hidden");
  texto.toggleAttribute("hidden", !show);
  toolTexto.setAttribute("aria-pressed", String(show));
});
```

Nota: `delivery` ainda não existe (nasce na Task 8) — o `?.` cobre isso; a Task 10 trava a fiação final.

Em `contexto.js`, adicionar no topo (após os imports) a âncora mínima — a Task 5 move a lógica de watched/aprovação para cá:

```js
/** Prévia central (#stage): nesta task só ancora; a Task 5 move a lógica. */
export function mountStage() {
  const stage = document.getElementById("stage");
  if (!stage) return;
  if (!document.getElementById("previewPlayer")) {
    const video = document.createElement("video");
    video.id = "previewPlayer";
    video.controls = true;
    video.preload = "metadata";
    stage.prepend(video);
  }
}
```

- [ ] **Step 3d: Remover o `.rail-head` do `rail.js` (status agora mora no topbar)**

Apagar o bloco das linhas 76–87 de `mountRail`:

```js
  const head = document.createElement("div");
  head.className = "rail-head";
  const brand = document.createElement("strong");
  brand.textContent = "decupa";
  const status = document.createElement("span");
  status.className = "hint";
  status.id = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "carregando…";
  head.append(brand, status);
  root.appendChild(head);
```

Nada mais em `rail.js` referencia `#status` (verificado por grep) — `renderStatus` no `page.js` encontra o `#status` do topbar. Manter a regra CSS `.rail-head` (harmless) ou removê-la junto — executor decide e registra no commit.

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run tests/redesign-shell.test.ts tests/redesign-theme.test.ts apps/cli/src/app/assembly/editor tests/assembly-flow.test.ts`
Expected: PASS. (`assembly-flow` prova que importar→preparar→exportar segue funcionando por HTTP.)

- [ ] **Step 5: Prova visual + checagem funcional**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T3-montar.png
playwright-cli resize 390 844 && playwright-cli screenshot --filename=png/redesign-T3-montar-390.png
```

Expected: topbar 56px com status; etapas clicáveis rolando até as regiões; trilho Texto mostra/oculta o texto; prévia aparece no centro (vídeo pode estar vazio no mock — o que importa é o `<video id="previewPlayer">` renderizado); sem scroll horizontal em 1440 e 390; comparar com `previews/01-editor.png`.

- [ ] **Step 6: Commit**

```bash
git add tests/redesign-shell.test.ts apps/cli/src/app/assembly/page.html apps/cli/src/app/assembly/page.css apps/cli/src/app/assembly/page.js apps/cli/src/app/assembly/editor/rail.js apps/cli/src/app/assembly/editor/contexto.js
git commit -m "feat(ui): shell da bancada (topbar, etapas, palco central, timeline)"
```

### Task 4: Rail vira navegador de materiais + diálogos (Etapa B/2)

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/rail.js` (countsFor; `#sourceCounts`; briefing→dialog; prep-confirm→dialog)
- Modify: `apps/cli/src/app/assembly/editor/rail.test.ts` (import + testes de `countsFor`)
- Modify: `tests/redesign-shell.test.ts` (pins de `briefingDialog`/`prepDialog`)
- Modify: `apps/cli/src/app/assembly/page.css` (estilo de `dialog`)

**Interfaces:**
- Consumes: shapes existentes (`project.assembly.sources[]` com `{id, name, role, included, durationSeconds}`; `project.input.{kind,text,targetSeconds}`; `project.permissions.visual`)
- Produces: `countsFor(sources) -> {total: number, included: number, support: number}` (support conta `role === "support" || role === "both"`); dialogs `#briefingDialog`, `#prepDialog` (nativos, Esc grátis); ids `#kind/#inputText/#target/#saveInput/#prepare` preservados — handlers e `render()` continuam funcionando sem mudança de payload

Notas de escopo: a entrega (checklist, cadeado, export) FICA no rail nesta task e muda para o inspetor na Task 8 — a UI segue completa ao fim de cada task. Nenhum payload de `/project/*` muda.

- [ ] **Step 1: Escrever os testes (falham antes)**

Em `apps/cli/src/app/assembly/editor/rail.test.ts`, trocar a linha 2 por:

```ts
import { countsFor, deliveryChecklist, exportView } from "./rail.js";
```

E anexar ao fim do arquivo:

```ts
it("countsFor resume fontes/incluídas/apoio", () => {
  expect(countsFor([])).toEqual({ total: 0, included: 0, support: 0 });
  expect(countsFor([
    { included: true, role: "speech" },
    { included: false, role: "support" },
    { included: true, role: "both" },
  ])).toEqual({ total: 3, included: 2, support: 2 });
});
```

Em `tests/redesign-shell.test.ts`, anexar:

```ts
it("rail.js ancora briefing e confirmação em dialogs nativos", async () => {
  const js = await readFile(new URL("../apps/cli/src/app/assembly/editor/rail.js", import.meta.url), "utf8");
  for (const s of ['id = "briefingDialog"', 'id = "prepDialog"', "showModal"]) {
    expect(js).toContain(s);
  }
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/rail.test.ts tests/redesign-shell.test.ts`
Expected: FAIL — `countsFor` não exportado; `briefingDialog` ausente.

- [ ] **Step 3a: `countsFor` + contador no cabeçalho de materiais**

Após `exportView` (linha 62 de `rail.js`), inserir:

```js
/**
 * Resumo das fontes para o cabeçalho de materiais (puro): total,
 * incluídas e apoio (role support OU both). Testado sem DOM.
 */
export function countsFor(sources) {
  const list = sources || [];
  return {
    total: list.length,
    included: list.filter((source) => source.included).length,
    support: list.filter((source) => source.role === "support" || source.role === "both").length,
  };
}
```

No `innerHTML` de materiais (linhas 89–99), trocar `'<h1>Materiais</h1>'` por `'<h1>Materiais</h1><p class="muted" id="sourceCounts" aria-live="polite"></p>'`. Em `renderSources`, inserir antes de `renderBatchButtons();` (linha 226):

```js
  const countsEl = document.getElementById("sourceCounts");
  if (countsEl) {
    const counts = countsFor(project.assembly.sources);
    countsEl.textContent = counts.total + " fonte(s) · " + counts.included + " incluída(s) · " + counts.support + " apoio";
  }
```

- [ ] **Step 3b: Briefing vira `<dialog>` (ids dos campos preservados)**

Substituir o bloco da seção briefing (linhas 102–111) por:

```js
  const briefingDialog = document.createElement("dialog");
  briefingDialog.id = "briefingDialog";
  briefingDialog.setAttribute("aria-labelledby", "briefingTitle");
  briefingDialog.innerHTML = '<h1 id="briefingTitle">Briefing</h1>'
    + '<label>Tipo <select id="kind"><option value="brief">briefing</option><option value="script">roteiro</option></select></label>'
    + '<label>Texto <textarea id="inputText" rows="4"></textarea></label>'
    + '<label>Duração alvo (s) <input id="target" type="number" min="1" value="60"></label>'
    + '<div class="row"><button type="button" id="saveInput">Guardar briefing</button>'
    + '<button type="button" id="closeBriefing">Fechar</button></div>';
  document.body.appendChild(briefingDialog);
  let briefingAutoOpened = false;
  document.getElementById("openBriefing").onclick = () => briefingDialog.showModal();
  document.getElementById("closeBriefing").onclick = () => briefingDialog.close();
```

Os ids `#kind/#inputText/#target/#saveInput` continuam existindo (agora dentro do dialog), então as linhas 378–380 do `render()` e o handler `#saveInput` (linhas 426–435) funcionam SEM alteração. Substituir as linhas 383–385 (auto-abrir do `<details>`) por:

```js
    // Projeto sem fontes abre o briefing sozinho, uma vez: o primeiro gesto
    // é colar o roteiro e arrastar mídia (era o <details> aberto, Task 4).
    if (!briefingAutoOpened && project.assembly.sources.length === 0) {
      briefingAutoOpened = true;
      briefingDialog.showModal();
    }
```

- [ ] **Step 3c: Confirmação de preparação vira `<dialog>` (mesmo payload)**

No `innerHTML` de preparação (linhas 115–120), remover `+ '<div id="prepareConfirm" hidden></div>'`. Após `root.appendChild(preparation);` (linha 121), inserir:

```js
  const prepDialog = document.createElement("dialog");
  prepDialog.id = "prepDialog";
  prepDialog.setAttribute("aria-labelledby", "prepTitle");
  document.body.appendChild(prepDialog);
```

Reescrever `openPrepareConfirm` (linhas 332–374) por:

```js
  /** Consentimento pago por lote: diálogo nativo, nunca confirm() nativo. */
  function openPrepareConfirm(project) {
    prepDialog.replaceChildren();
    const title = document.createElement("h1");
    title.id = "prepTitle";
    title.textContent = "Preparar montagem";
    const count = project.assembly.sources.filter((source) => source.included).length;
    const note = document.createElement("p");
    if (project.permissions.visual === true) {
      // Permissão é monotônica: já concedida, só declara o estado honesto.
      note.textContent = "já autorizado (persistente) — a preparação usa o modelo visual pago e envia as mídias ao provedor.";
    } else {
      note.textContent = "Vai analisar " + count + " arquivo(s) — custo estimado do modelo visual + envio das mídias ao provedor. Continuar?";
    }
    const row = document.createElement("div");
    row.className = "row";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary";
    go.textContent = "Preparar agora";
    go.addEventListener("click", () => {
      prepDialog.close();
      // O clique no lote é o opt-in: o servidor persiste em permissions.
      void api.call("/project/prepare", {
        method: "POST",
        body: JSON.stringify({
          baseRevision: state.get("project").revision, request: "",
          modelOptIn: true, visualOptIn: true,
        }),
        label: "Iniciando preparação…",
      });
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancelar";
    cancel.addEventListener("click", () => prepDialog.close());
    row.append(go, cancel);
    prepDialog.append(title, note, row);
    prepDialog.showModal();
  }
```

E substituir as linhas 396–399 do `render()` por:

```js
    if (preparing && prepDialog.open) prepDialog.close();
```

- [ ] **Step 3d: Estilo dos dialogs no `page.css`** (anexar ao fim):

```css
dialog { background: var(--panel); color: var(--ink); border: 1px solid var(--line-strong);
  border-radius: 10px; padding: 18px 20px; max-width: min(480px, 92vw); }
dialog::backdrop { background: rgb(0 0 0 / .55); }
dialog h1 { margin-top: 0; }
```

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/rail.test.ts tests/redesign-shell.test.ts tests/assembly-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Prova visual + checagem funcional**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T4-montar.png
```

Expected: rail mostra só Materiais + Preparação + Entrega (sem briefing inline); contador "N fonte(s) · …" sob o título; botão Briefing no topbar abre o dialog (Esc fecha); Preparar montagem abre `#prepDialog` com o mesmo texto de custo; `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/rail.js apps/cli/src/app/assembly/editor/rail.test.ts tests/redesign-shell.test.ts apps/cli/src/app/assembly/page.css
git commit -m "feat(ui): rail como navegador de materiais com dialogs de briefing e preparo"
```

---

### Task 5: Prévia no palco central + inspetor contextual (Etapa B/3)

**Files:**
- Create: `apps/cli/src/app/assembly/editor/contexto.test.ts`
- Modify: `apps/cli/src/app/assembly/editor/contexto.js` (âncora `mountStage` da Task 3 vira o mount completo; `mountContexto` fica só com correções + ajuste + `#inspectorState`)

**Interfaces:**
- Consumes: `watchedState(project, watched)` (`./watched.js`, intacto); `montageDuration(project)` (`./montage.js`, intacto); `player.el()/player.previewBusy()` (inalterados — o `#previewPlayer` continua único, agora filho de `#stage`)
- Produces: `mountStage({state, api, player}) -> void` (substitui a âncora mínima da Task 3); `inspectorSections(project) -> {corrections: number, hasPreview: boolean, approved: boolean}` (`approved` = `finalApprovedRevision === revision`, i.e. aprovação da revisão ATUAL — edição invalida, spec §5)

Todo o comportamento de watched/aprovação/prévia é movido VERBATIM de `mountContexto` para `mountStage` — só o elemento-raiz muda. `backgroundBusy(project, operation)` vira `backgroundBusy(project, operation, player)` em nível de módulo (era closure; os dois mounts usam).

- [ ] **Step 1: Escrever o teste de `inspectorSections` (falha antes)**

```ts
// apps/cli/src/app/assembly/editor/contexto.test.ts
import { expect, it } from "vitest";
import { inspectorSections } from "./contexto.js";

function project(over: Record<string, unknown> = {}) {
  return { revision: 5, previewRevision: 5, finalApprovedRevision: null, corrections: [], ...over };
}

it("conta correções não alinhadas e estado de prévia/aprovação", () => {
  expect(inspectorSections(project())).toEqual({ corrections: 0, hasPreview: true, approved: false });
  expect(inspectorSections(project({
    corrections: [{ status: "pending" }, { status: "error" }, { status: "aligned" }],
  }))).toMatchObject({ corrections: 2 });
  expect(inspectorSections(project({ previewRevision: null }))).toMatchObject({ hasPreview: false });
  expect(inspectorSections(project({ finalApprovedRevision: 5 }))).toMatchObject({ approved: true });
  expect(inspectorSections(project({ finalApprovedRevision: 4 }))).toMatchObject({ approved: false });
});

it("sem projeto: tudo zerado", () => {
  expect(inspectorSections(null)).toEqual({ corrections: 0, hasPreview: false, approved: false });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/contexto.test.ts`
Expected: FAIL — `inspectorSections` não exportado.

- [ ] **Step 3a: `inspectorSections` + `backgroundBusy` em nível de módulo**

Após `paidFlags` (linhas 24–30 de `contexto.js`), inserir:

```js
/**
 * Resumo do inspetor (puro): correções não alinhadas, existência de prévia
 * e aprovação DA REVISÃO ATUAL (edição invalida — spec §5).
 */
export function inspectorSections(project) {
  if (!project) return { corrections: 0, hasPreview: false, approved: false };
  return {
    corrections: (project.corrections || []).filter((item) => item.status !== "aligned").length,
    hasPreview: project.previewRevision != null,
    approved: project.finalApprovedRevision === project.revision,
  };
}

/** Trabalho de fundo que bloqueia ajuste/atualização (puro, sem DOM). */
function backgroundBusy(project, operation, player) {
  const OP_LABEL = {
    analyzing: "Analisando mídia",
    preparing: "Preparando montagem",
    rendering: "Renderizando prévia",
    proposing: "Propondo cenas",
  };
  if (operation && OP_LABEL[operation.stage]) return true;
  if (project && project.preparation && project.preparation.status === "running") return true;
  if (player.previewBusy()) return true;
  return false;
}
```

E APAGAR a versão closure de `backgroundBusy` dentro de `mountContexto` (linhas 106–117).

- [ ] **Step 3b: `mountStage` completo (substitui a âncora da Task 3)**

Apagar a âncora mínima e escrever o mount completo. Estrutura (reaproveitar código verbatim das linhas indicadas):

```js
/**
 * Palco central da prévia (#stage): player único, frescor, aprovação.
 * Todo o comportamento veio verbatim do mountContexto — só a raiz mudou.
 */
export function mountStage({ state, api, player }) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  let previewPlayer = document.getElementById("previewPlayer");
  if (!previewPlayer) {
    previewPlayer = document.createElement("video");
    previewPlayer.id = "previewPlayer";
    previewPlayer.controls = true;
    previewPlayer.preload = "metadata";
    stage.prepend(previewPlayer);
  }
  const note = document.createElement("div");
  note.className = "preview-meta";
  note.id = "previewNote";
  note.hidden = true;
  note.setAttribute("aria-live", "polite");
  const meta = document.createElement("div");
  meta.className = "preview-meta";
  meta.id = "deliveryMeta";
  const fresh = document.createElement("p");
  fresh.className = "muted";
  fresh.id = "freshChip";
  fresh.setAttribute("aria-live", "polite");
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Assista à prévia atual antes de aprovar.";
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = '<button type="button" id="refreshPreview">Atualizar prévia</button>'
    + '<button type="button" class="primary" id="approveFinal">Aprovar prévia assistida</button>';
  stage.append(note, meta, fresh, hint, row);

  // --- abaixo, COPIAR VERBATIM do mountContexto atual: ---
  // - rastreio watched (linhas 71–104: lastTime, isPreviewSrc, nearEnd,
  //   markWatched, resetWatched + 4 listeners), trocando apenas a fonte de
  //   previewPlayer (já resolvido acima, sem getElementById de novo);
  // - renderFreshness (linhas 119–126);
  // - renderPreview (linhas 128–192), trocando a chamada
  //   backgroundBusy(project, state.get("operation")) por
  //   backgroundBusy(project, state.get("operation"), player);
  // - handlers refreshPreview (251–263) e approveFinal (264–281).

  state.subscribe("project", (project) => renderPreview(project));
  state.subscribe("watched", () => renderFreshness(state.get("project")));
  renderPreview(state.get("project"));
}
```

Notas de adaptação obrigatórias na cópia: (a) em `renderFreshness`, guardar contra projeto nulo — o subscribe de `watched` pode disparar antes de haver projeto: trocar `if (!project) return;` (já existe na linha 121 — manter); (b) em `renderPreview`, a primeira linha `if (!project.scenes.length) return;` quebra com projeto nulo — trocar por `if (!project || !project.scenes.length) return;`.

- [ ] **Step 3c: `mountContexto` fica só com correções + ajuste + estado**

1. Apagar a criação da seção preview (linhas 36–46).
2. Apagar o bloco de listeners watched (linhas 66–104, da declaração `const previewPlayer` até o fim do listener `loadstart`).
3. Apagar `renderFreshness` e `renderPreview` (linhas 119–192).
4. Apagar os handlers `refreshPreview` e `approveFinal` (linhas 251–281).
5. No início do mount (após `root.replaceChildren();`, linha 34), inserir:

```js
  const inspectorState = document.createElement("p");
  inspectorState.className = "muted";
  inspectorState.id = "inspectorState";
  inspectorState.setAttribute("aria-live", "polite");
  root.appendChild(inspectorState);
```

6. Em `render()`, substituir a chamada `renderPreview(project);` (linha 221) por:

```js
    const sections = inspectorSections(project);
    document.getElementById("inspectorState").textContent =
      (sections.hasPreview ? "prévia " + project.previewRevision : "sem prévia")
      + " · " + sections.corrections + " correção(ões) pendente(s)"
      + (sections.approved ? " · aprovada ✓" : "");
```

7. Atualizar as chamadas de `backgroundBusy`: linha 229 `backgroundBusy(project, operation)` → `backgroundBusy(project, operation, player)`.
8. Ajustar os subscribes finais (linhas 282–284) para:

```js
  state.subscribe("project", render);
  state.subscribe("operation", () => render(state.get("project")));
  render(state.get("project"));
```

(remover o subscribe de `watched` — ele agora vive no `mountStage`).

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor tests/assembly-flow.test.ts tests/assembly-delivery.test.ts`
Expected: PASS — inclui `baseline.test.ts` (aprovação/invalidação intactos) e delivery HTTP (aprovação servidor intacta).

- [ ] **Step 5: Prova visual + checagem funcional**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T5-montar.png
```

Expected: prévia (player + chips + Atualizar/Aprovar) NO CENTRO acima do texto; inspetor à direita só com estado + Correções + Ajuste; comparar com `previews/01-editor.png`. Checagem funcional no mock: botão Aprovar desabilitado até assistir (gate preservado). `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/contexto.js apps/cli/src/app/assembly/editor/contexto.test.ts
git commit -m "feat(ui): previa no palco central e inspetor contextual"
```

---

### Task 6: Timeline com espaço — régua, timecode, fontes, legendas reais (Etapa B/4)

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/sequencia.js` (`formatTimecode`, `captionCues`, régua/timecode, chips de fonte, lane de legendas, strip 64px)
- Modify: `apps/cli/src/app/assembly/editor/sequencia.test.ts` (import + testes)
- Modify: `apps/cli/src/app/assembly/page.css` (estilo `.seq-captions/.seq-cue`)

**Interfaces:**
- Consumes: `timelineBlocks(project)`, `montageDuration(project)`, `retainedSegments(project)` (`./montage.js`, intactos); `project.captions?: Array<{start, end, text}>` (opcional — backend atual NÃO envia; ausência = sem lane, nunca lane fictícia)
- Produces: `formatTimecode(seconds) -> "MM:SS.mmm"`; `captionCues(project) -> Array<{start, end, text}>` normalizado/ordenado

Não-metas explícitas (honestidade de dados): sem controle de zoom (não há contrato; a régua nice + timecode + scrub atendem a Etapa B); sem seletor de proporção (a prévia renderiza no WxH real da montagem — o `<video>` usa `object-fit: contain`, conteúdo nunca distorcido, e `#deliveryMeta` já exibe WxH/fps reais); sem botão refazer (o backend só tem `/project/undo` por revisão — verificado por grep, não existe redo; refazer exige contrato de histórico-para-frente no servidor e fica como expansão futura).

- [ ] **Step 1: Escrever os testes (falham antes)**

Em `sequencia.test.ts`, estender o import (linhas 4–11) com `captionCues` e `formatTimecode`:

```ts
import {
  activeScene,
  blocksAt,
  bucketizeSegments,
  captionCues,
  formatTimecode,
  planSceneWave,
  rulerTicks,
  seekFromRatio,
} from "./sequencia.js";
```

Anexar ao fim do arquivo:

```ts
it("formatTimecode em MM:SS.mmm", () => {
  expect(formatTimecode(0)).toBe("00:00.000");
  expect(formatTimecode(61.5)).toBe("01:01.500");
  expect(formatTimecode(600)).toBe("10:00.000");
  expect(formatTimecode(NaN)).toBe("00:00.000");
  expect(formatTimecode(-3)).toBe("00:00.000");
});

it("captionCues só com dado real, normalizado e ordenado", () => {
  expect(captionCues({})).toEqual([]);
  expect(captionCues({ captions: null })).toEqual([]);
  expect(captionCues({
    captions: [
      { start: 2, end: 3, text: "b" },
      { start: 0, end: 1, text: "a" },
      { start: 5, end: 4, text: "inválido" },
    ],
  })).toEqual([
    { start: 0, end: 1, text: "a" },
    { start: 2, end: 3, text: "b" },
  ]);
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/sequencia.test.ts`
Expected: FAIL — `formatTimecode`/`captionCues` não exportados.

- [ ] **Step 3a: Funções puras** (inserir após `rulerTicks`, linha 56 de `sequencia.js`):

```js
/**
 * Timecode mono tabular MM:SS.mmm (puro). Não-finito/negativo vira zero.
 */
export function formatTimecode(seconds) {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  return String(Math.floor(ms / 60000)).padStart(2, "0") + ":"
    + String(Math.floor(ms / 1000) % 60).padStart(2, "0") + "."
    + String(ms % 1000).padStart(3, "0");
}

/**
 * Cues de legenda do projeto (puro): só dado real — quando o backend não
 * envia `captions`, devolve [] e a UI não desenha a lane.
 */
export function captionCues(project) {
  const cues = project && Array.isArray(project.captions) ? project.captions : [];
  return cues
    .filter((cue) => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .map((cue) => ({ start: cue.start, end: cue.end, text: String(cue.text ?? "") }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
```

- [ ] **Step 3b: Cabeçalho com timecode total + chips de fonte**

Substituir a linha 200 (`total.textContent = ...`) por:

```js
    total.textContent = formatTimecode(duration);
```

Após `head.append(label, total);` (linha 201), inserir:

```js
    for (const source of p.assembly.sources.filter((item) => item.included)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = source.name + " · " + Math.round(source.durationSeconds) + "s";
      head.appendChild(chip);
    }
```

- [ ] **Step 3c: Régua em timecode + strip mais alto + títulos precisos**

1. Régua (linhas 208–214): trocar `s.textContent = t === 0 ? "0s" : String(t);` por `s.textContent = formatTimecode(t);`
2. Strip (linha 218): trocar `min-height:28px` por `min-height:64px`.
3. Título do bloco (linha 226): trocar por:

```js
      const title = block.label + " · " + formatTimecode(block.start) + "–" + formatTimecode(block.end);
```

4. Chip do playhead (linha 345): trocar `chip.textContent = playhead.toFixed(1).replace(".", ",") + "s";` por `chip.textContent = formatTimecode(playhead);`

(O chip de duração por bloco `.dur` mantém o formato curto "12,3s" — espaço.)

- [ ] **Step 3d: Lane de legendas só com dado real**

Antes de `el.replaceChildren(head, ruler, strip, transportRow(p));` (linha 242), inserir:

```js
    const cues = captionCues(p);
    let captions = null;
    if (cues.length) {
      captions = document.createElement("div");
      captions.className = "seq-captions";
      captions.setAttribute("aria-label", "Legendas");
      for (const cue of cues) {
        const cueEl = document.createElement("span");
        cueEl.className = "seq-cue";
        cueEl.title = cue.text;
        cueEl.textContent = cue.text;
        cueEl.style.left = duration > 0 ? ((cue.start / duration) * 100).toFixed(3) + "%" : "0%";
        cueEl.style.width = duration > 0
          ? (Math.max(0, (cue.end - cue.start) / duration) * 100).toFixed(3) + "%" : "0%";
        captions.appendChild(cueEl);
      }
    }
```

E trocar a linha 242 por:

```js
    el.replaceChildren(head, ruler, strip, ...(captions ? [captions] : []), transportRow(p));
```

- [ ] **Step 3e: Estilo da lane** (anexar ao `page.css`):

```css
.seq-captions { position: relative; min-height: 22px; border-top: 1px solid var(--line); margin-top: 6px; }
.seq-cue { position: absolute; top: 2px; height: 18px; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; font-size: 11px; color: var(--accent);
  background: rgb(240 202 110 / .12); border-left: 2px solid var(--accent); padding: 0 4px; }
```

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor tests/assembly-flow.test.ts`
Expected: PASS (todos os testes de `blocksAt/rulerTicks/bucketize/planSceneWave` intactos).

- [ ] **Step 5: Prova visual**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T6-montar.png
```

Expected: timeline de 266px com régua em `MM:SS.mmm`, total em timecode, chips de fonte no cabeçalho, blocos mais altos com waveform, playhead com timecode; SEM lane de legendas no mock atual (backend não envia `captions` — ausência correta). `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/sequencia.js apps/cli/src/app/assembly/editor/sequencia.test.ts apps/cli/src/app/assembly/page.css
git commit -m "feat(ui): timeline com regua, timecode, fontes e legendas reais"
```

### Task 7: Texto sem rebuild + limpeza no mesmo sistema visual (Etapa C)

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/texto.js` (`docSignature`; `render()` com skip; `renderCenter` sem forçar `hidden`, com scroll preservado)
- Modify: `apps/cli/src/app/assembly/editor/texto.test.ts` (import + testes de `docSignature`)
- Modify: `apps/cli/src/app/page.html` (tokens `:root`, prosa 18px, header 56px — SOMENTE CSS, zero JS)
- Modify: `tests/redesign-theme.test.ts` (pin dos tokens na limpeza)

**Interfaces:**
- Consumes: `takeWords(p, scene, take)`, `effectiveWords(p, sourceId)` (`./montage.js`, intactos); `needsEmptyGuide(p)` (mesmo arquivo)
- Produces: `docSignature(p) -> string` (`"empty"` | `"transcript|…"` | `"prose|…"`; metadados como revisão/prévia NÃO entram)

Contexto importante (verificado no código): seleção e playhead JÁ não recriam o DOM (`paintSelection`, `paintPlayhead`). O rebuild integral acontece a cada `set("project")` — inclusive polls de correção e atualizações de prévia — via `renderCenter` com `innerHTML`. É isso que esta task elimina, mais dois defeitos reais: `renderCenter` força `texto.hidden = false` (quebraria o toggle de ferramentas da Task 3) e perde o scroll de `#center`.

- [ ] **Step 1: Escrever os testes (falham antes)**

Em `texto.test.ts`, estender o import (linhas 2–8) com `docSignature` (ordem alfabética, após `acceptedFormatsLabel`). Anexar ao fim:

```ts
function docProject(over: Record<string, unknown> = {}) {
  return {
    assembly: { sources: [{ id: "a" }] },
    analyses: [{ sourceId: "a", words: [
      { id: "w1", text: "ola", start: 0, end: 0.5 },
      { id: "w2", text: "mundo", start: 0.5, end: 1 },
    ] }],
    corrections: [],
    scenes: [{ id: "s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1 }] }],
    preparation: null,
    ...over,
  };
}

it("docSignature estável a metadados, sensível a conteúdo", () => {
  expect(docSignature(docProject())).toBe(docSignature(docProject({ revision: 9, previewRevision: 9 })));
});

it("docSignature muda em corte/proteção/correção/texto", () => {
  const base = docSignature(docProject());
  const cut = docProject({ scenes: [{ id: "s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, removed: [{ start: 0, end: 0.5 }] }] }] });
  expect(docSignature(cut)).not.toBe(base);
  const prot = docProject({ scenes: [{ id: "s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, protected: [{ start: 0, end: 1 }] }] }] });
  expect(docSignature(prot)).not.toBe(base);
  const fixed = docProject({ analyses: [{ sourceId: "a", words: [
    { id: "a:sha:c:1:w000001", text: "olá", start: 0, end: 0.5 },
    { id: "w2", text: "mundo", start: 0.5, end: 1 },
  ] }] });
  expect(docSignature(fixed)).not.toBe(base);
});

it("docSignature vazio/transcrito", () => {
  expect(docSignature(null)).toBe("empty");
  expect(docSignature({ assembly: { sources: [] } })).toBe("empty");
  expect(docSignature(docProject({ scenes: [] })).startsWith("transcript|")).toBe(true);
});
```

Em `tests/redesign-theme.test.ts`, anexar:

```ts
it("limpeza usa os mesmos tokens da montagem", async () => {
  const html = await readFile(new URL("../apps/cli/src/app/page.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--panel: #191A1D", "--accent: #F0CA6E"]) {
    expect(html).toContain(token);
  }
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/texto.test.ts tests/redesign-theme.test.ts`
Expected: FAIL — `docSignature` não exportado; token ausente na limpeza.

- [ ] **Step 3a: `docSignature`** (inserir após `needsEmptyGuide`, linha 163 de `texto.js`):

```js
/**
 * Assinatura visual do documento central (pura): modo + ids/textos/flags de
 * palavra. Metadados (revisão, prévia, seleção) NÃO entram — um `set` de
 * projeto que só atualiza a prévia gera a mesma assinatura e o render pode
 * pular o rebuild, preservando scroll/foco/reprodução.
 */
export function docSignature(p) {
  if (!p || needsEmptyGuide(p)) return "empty";
  if (p.scenes.length === 0) {
    return "transcript|" + p.assembly.sources.map((source) =>
      source.id + ":" + effectiveWords(p, source.id).map((word) => word.text).join(" "),
    ).join("|") + "|" + (p.preparation ? p.preparation.status : "");
  }
  return "prose|" + p.scenes.map((scene) =>
    scene.id + ":" + scene.takes.map((take) =>
      take.id + ":" + takeWords(p, scene, take).map((word) =>
        word.id + "," + (word.display || word.text)
        + (word.removed ? "-r" : "") + (word.protected ? "-p" : "") + (word.corrected ? "-c" : ""),
      ).join(";"),
    ).join("|"),
  ).join("||");
}
```

- [ ] **Step 3b: `render()` com skip + `renderCenter` sem roubar visibilidade/scroll**

Em `mountTexto`, inserir `let lastSig = null;` após `const selection = ...` (linha 453) e trocar `render()` (linhas 455–458) por:

```js
  let lastSig = null;
  function render(p) {
    if (!p) return;
    const sig = docSignature(p);
    if (sig === lastSig) {
      const el = root();
      if (el) paintSelection(el, selection());
      return;
    }
    lastSig = sig;
    renderCenter(p, selection());
  }
```

Em `renderCenter` (linhas 340–371): remover as duas linhas `texto.hidden = false;` (351 e 358) — a visibilidade é autoridade do toggle `data-tool="texto"` (Task 3). E preservar o scroll de `#center` no ramo principal — trocar o bloco das linhas 357–364 por:

```js
  dropzone.hidden = true;
  const scroller = document.getElementById("center");
  const top = scroller ? scroller.scrollTop : 0;
  // Coluna de leitura: o documento (transcrição ou prosa) inteiro dentro do
  // wrapper .measure; os gestos continuam no #texto, então trocar os filhos
  // não afeta a delegação.
  texto.innerHTML = '<div class="measure">'
    + (p.scenes.length === 0 ? renderTranscript(p) : renderProse(p, selection))
    + "</div>";
  if (scroller) scroller.scrollTop = top;
```

- [ ] **Step 3c: Limpeza no mesmo sistema visual (só CSS)**

1. Em `apps/cli/src/app/page.html`, substituir o `:root` (linhas 6–15) pelo bloco canônico dos Global Constraints (com os aliases `--bg-0/--bg-1/--bg-2/--ok/--warn`, pois o arquivo usa esses nomes).
2. Prosa (linhas 50–53): trocar `max-width: 34em` → `38em`, `font-size: 20px` → `18px`, `line-height: 1.65` → `1.7` (legível sem dominar como artigo editorial — spec §4).
3. Header (linhas 24–28): acrescentar `min-height: 56px; box-sizing: border-box;` (mesma altura do `#topbar`).
4. NADA de JS: triagem mantém decisão explícita (`#triage-apply`/`#triage-dismiss`); export mantém os 4 formatos; `.gone` segue riscado inline (não é cor como único indicador).

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor tests/redesign-theme.test.ts tests/engine-gold.test.ts`
Expected: PASS (`engine-gold` prova equivalência do motor da limpeza).

- [ ] **Step 5: Prova visual**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T7-montar.png
playwright-cli open http://127.0.0.1:7791/ && playwright-cli screenshot --filename=png/redesign-T7-limpar.png
```

Expected: montagem com texto no mesmo tema; limpeza com tokens novos e prosa 18px; comparar com `previews/02-transcript.png`. Checagem funcional: no mock, clicar palavras não recria a tela (scroll estável). `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/texto.js apps/cli/src/app/assembly/editor/texto.test.ts apps/cli/src/app/page.html tests/redesign-theme.test.ts
git commit -m "feat(ui): texto sem rebuild e limpeza no mesmo sistema visual"
```

---

### Task 8: Entrega no inspetor + preparação com recuperação honesta (Etapa D)

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/rail.js` (remove entrega; adiciona `stageLabel`, `#opLine`, `renderOpLine`, subscribe de `operation`, vazio honesto de prep)
- Modify: `apps/cli/src/app/assembly/editor/rail.test.ts` (import `stageLabel`; testes de `stageLabel` + `exportView` com formatos)
- Modify: `apps/cli/src/app/assembly/editor/contexto.js` (importa `deliveryChecklist/exportView` de `./rail.js`; seção `#delivery` + `renderDelivery` + `#versionHistory`; `#cancelPrep` vira "Cancelar preparação")
- Modify: `tests/redesign-shell.test.ts` (pin da entrega no inspetor)

**Interfaces:**
- Consumes: `exportView(ui, approved, formats?)`, `deliveryChecklist(project)` (`./rail.js`); `state.get("operation")` (`{stage, sourceId?, progress?, error?}`); `inspectorSections` (Task 5, intacto)
- Produces: `stageLabel(stage) -> string` (mapa + fallback `String(stage)`); `exportView(ui, approved, formats = null)` (terceiro parâmetro OPCIONAL e backward-compatible: com `formats == null` o retorno é byte-idêntico ao antigo — testes existentes intocados); `#delivery` com `#deliveryChecklist/#deliveryLock/#export/#exportStatus/#downloads/#versionHistory`; `#opLine` (etapa + progresso + material afetado + erro)

- [ ] **Step 1: Escrever os testes (falham antes)**

Em `rail.test.ts`, trocar o import por:

```ts
import { countsFor, deliveryChecklist, exportView, stageLabel } from "./rail.js";
```

Anexar ao fim:

```ts
it("exportView sem formatos preserva o contrato antigo", () => {
  expect(exportView({ status: "idle", error: null }, true)).not.toHaveProperty("formats");
});

it("exportView com formatos ecoa capacidades", () => {
  const formats = [{ id: "otio", label: "Baixar timeline.otio", href: "/project/output/3/otio", file: "timeline.otio" }];
  expect(exportView({ status: "done", error: null }, true, formats)).toMatchObject({ tone: "done", formats });
});

it("stageLabel traduz etapas e repassa desconhecidas", () => {
  expect(stageLabel("rendering")).toBe("Renderizando prévia");
  expect(stageLabel("cancelled")).toBe("Cancelada");
  expect(stageLabel("weird-stage")).toBe("weird-stage");
});
```

Em `tests/redesign-shell.test.ts`, anexar:

```ts
it("entrega mora no inspetor, não no rail", async () => {
  const rail = await readFile(new URL("../apps/cli/src/app/assembly/editor/rail.js", import.meta.url), "utf8");
  const contexto = await readFile(new URL("../apps/cli/src/app/assembly/editor/contexto.js", import.meta.url), "utf8");
  expect(rail).not.toContain("deliveryChecklist");
  expect(contexto).toContain('id = "delivery"');
  expect(contexto).toContain("versionHistory");
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor/rail.test.ts tests/redesign-shell.test.ts`
Expected: FAIL — `stageLabel` não exportado; rail ainda contém `deliveryChecklist`.

- [ ] **Step 3a: `stageLabel` + `exportView` com formatos (backward-compatible)**

Após `countsFor` em `rail.js`, inserir:

```js
const OP_STAGE_LABEL = {
  analyzing: "Analisando mídia",
  preparing: "Preparando montagem",
  rendering: "Renderizando prévia",
  proposing: "Propondo cenas",
  error: "Erro",
  cancelled: "Cancelada",
  ready: "Pronta",
};

/** Rótulo pt-BR da etapa da operação (puro); desconhecida repassa crua. */
export function stageLabel(stage) {
  return OP_STAGE_LABEL[stage] || String(stage);
}
```

Reescrever `exportView` (linhas 38–62) preservando cada ramo e adicionando o terceiro parâmetro:

```js
export function exportView(ui, approved, formats = null) {
  let view;
  if (ui.status === "running") {
    view = {
      disabled: true, loading: true, tone: "running",
      buttonLabel: "Exportando…", statusText: "Exportando…",
    };
  } else if (ui.status === "error") {
    view = {
      disabled: !approved, loading: false, tone: "error",
      buttonLabel: "Exportar revisão",
      statusText: "Erro no export: " + (ui.error || "falha desconhecida"),
    };
  } else if (ui.status === "done") {
    view = {
      disabled: !approved, loading: false, tone: "done",
      buttonLabel: "Exportado ✓", statusText: "Exportado ✓ — links abaixo.",
    };
  } else {
    view = {
      disabled: !approved, loading: false, tone: "idle",
      buttonLabel: "Exportar revisão", statusText: "",
    };
  }
  return formats == null ? view : { ...view, formats };
}
```

Os 4 ramos acima são byte-idênticos ao original (linhas 38–62) — `rail.test.ts` trava todos e deve passar sem alteração.

- [ ] **Step 3b: Remover a entrega do rail; prep com `#opLine` e vazio honesto**

1. Apagar a seção delivery (linhas 123–132), `exportUi` (linha 136), `renderDelivery` (linhas 282–330) e o handler `#export` (linhas 446–469).
2. Em `render()`, apagar as linhas 401–404 (`delivery.hidden = false; renderDelivery(project);` + comentário).
3. No `innerHTML` de preparação, após `<p class="muted" id="prepSummary" ...></p>` inserir `<p class="muted" id="opLine" aria-live="polite"></p>`.
4. Após `renderPreparation`, inserir:

```js
  /** Linha da operação na preparação: etapa + progresso + material + erro. */
  function renderOpLine(operation) {
    const line = document.getElementById("opLine");
    if (!line) return;
    if (!operation || !operation.stage) {
      line.textContent = "";
      return;
    }
    const p = state.get("project");
    const source = operation.sourceId && p
      ? p.assembly.sources.find((item) => item.id === operation.sourceId) : null;
    line.textContent = stageLabel(operation.stage)
      + (operation.progress ? " · " + operation.progress : "")
      + (source ? " · " + source.name : "")
      + (operation.error ? ": " + operation.error : "");
  }
```

5. No fim do mount, após `state.subscribe("project", render);` (linha 471), inserir `state.subscribe("operation", renderOpLine);` e chamar `renderOpLine(state.get("operation"));` após `render(state.get("project"));`.
6. Em `renderPreparation`, após `box.replaceChildren();` (linha 233), inserir o vazio honesto:

```js
    const included = project.assembly.sources.filter((item) => item.included);
    if (!included.length) {
      document.getElementById("prepSummary").textContent = "Nenhuma fonte incluída — inclua materiais para preparar.";
      return;
    }
```

e trocar o `for` da linha 236 para iterar `included`.

- [ ] **Step 3c: Entrega no inspetor (`contexto.js`)**

1. No topo, estender imports: `import { deliveryChecklist, exportView } from "./rail.js";` (`rail.js` não executa DOM no top-level — import seguro).
2. Em `mountContexto`, após a seção de ajuste (`root.appendChild(briefingActions);`, linha 64), inserir:

```js
  const delivery = document.createElement("section");
  delivery.id = "delivery";
  delivery.setAttribute("aria-label", "Entrega");
  delivery.innerHTML = "<h1>Entrega</h1>"
    + '<ul id="deliveryChecklist" class="plain"></ul>'
    + '<p class="muted" id="deliveryLock" aria-live="polite"></p>'
    + '<div class="row"><button type="button" id="export">Exportar revisão</button></div>'
    + '<p class="muted" id="exportStatus" role="status" aria-live="polite"></p>'
    + '<p id="downloads"></p>'
    + '<ul id="versionHistory" class="plain"></ul>';
  root.appendChild(delivery);
  const exportUi = { status: "idle", error: null, revision: null };
```

3. Mover `renderDelivery` de `rail.js` para `mountContexto` VERBATIM, com estas adaptações obrigatórias: (a) formatos por capacidade — substituir o bloco `if (approved) { const rev = ...; otio/mp4 hardcoded }` (linhas 316–329 do rail) por:

```js
    const rev = project.finalApprovedRevision;
    const formats = approved ? [
      { id: "otio", label: "Baixar timeline.otio", href: "/project/output/" + rev + "/otio", file: "timeline.otio" },
      { id: "mp4", label: "Baixar reference.mp4", href: "/project/output/" + rev + "/mp4", file: "reference.mp4" },
    ] : null;
    const view = exportView(exportUi, approved, formats);
```

(movendo a chamada `exportView` para DEPOIS do cálculo de `formats`; o restante — botão, status — usa `view` como antes); (b) links via `view.formats`:

```js
    const downloads = document.getElementById("downloads");
    downloads.replaceChildren();
    for (const format of view.formats || []) {
      const link = document.createElement("a");
      link.className = "data";
      link.href = format.href;
      link.textContent = format.label;
      link.setAttribute("download", format.file);
      downloads.appendChild(link);
    }
```

(c) histórico de versões ao fim de `renderDelivery`:

```js
    const history = document.getElementById("versionHistory");
    history.replaceChildren(
      chip("revisão " + project.revision),
      chip(project.previewRevision != null ? "prévia " + project.previewRevision : "sem prévia"),
      chip(project.finalApprovedRevision != null ? "aprovada " + project.finalApprovedRevision : "não aprovada"),
    );
```

(`chip` e `setDisabled` já existem neste módulo com a mesma forma.)

4. Mover o handler `#export` (linhas 446–469 do rail) VERBATIM para `mountContexto` (usa `exportUi`, `renderDelivery`, `api` — todos no escopo).
5. Em `render()` de `mountContexto`, chamar `renderDelivery(project);` ao fim. Adicionar guarda de revisão obsoleta: `renderDelivery` já reseta `done`→`idle` quando a revisão anda (linhas 292–296 do rail — manter na cópia).
6. Renomear o botão de cancelamento (linha 63): `>Cancelar</button>` → `>Cancelar preparação</button>` (o backend só cancela — spec §5; semântica de pausa NÃO existe).

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run apps/cli/src/app/assembly/editor tests/redesign-shell.test.ts tests/assembly-delivery.test.ts tests/assembly-flow.test.ts`
Expected: PASS — `assembly-delivery` prova que o cadeado servidor (export sem aprovação recusado) segue valendo.

- [ ] **Step 5: Prova visual**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T8-montar.png
```

Expected: inspetor com Correções + Ajuste (com "Cancelar preparação" quando houver preparo) + Entrega (checklist, cadeado, export, downloads, histórico de versões); rail sem entrega; etapa "entrega" do `#stages` rola até `#delivery`. `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/rail.js apps/cli/src/app/assembly/editor/rail.test.ts apps/cli/src/app/assembly/editor/contexto.js tests/redesign-shell.test.ts
git commit -m "feat(ui): entrega no inspetor e preparacao com recuperacao honesta"
```

---

### Task 9: Setup e marcação no mesmo tema, contratos intactos (Etapa E)

**Files:**
- Create: `tests/redesign-surfaces.test.ts`
- Modify: `apps/cli/src/app/provider-setup.html` (SOMENTE o `<style>` — markup, copy e JS intactos)
- Modify: `apps/cli/src/mark-web/page.html` (SOMENTE o `:root` — layout, onda, atalhos e ajuda intactos)

**Interfaces:**
- Consumes: nada (páginas autocontidas)
- Produces: tokens canônicos nas duas superfícies; custódia local de chaves inalterada; marcação sem transcript/predição/sugestão (travado por teste)

Notas de escopo: a onda da marcação JÁ é o hero (grid `2fr 3fr`, 60% para a onda) — sem mudança de layout. A palavra "palavra" aparece no texto de AJUDA da marcação ("A palavra começa onde a energia sobe") — é instrução, não dado; o teste proíbe `transcript/predi/sugest/melhor posição`, não `palavra`. NÃO tocar em `provider-setup.test.ts` (arquivo com trabalho alheio em andamento na árvore).

- [ ] **Step 1: Escrever os testes (falham antes)**

```ts
// tests/redesign-surfaces.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("provider-setup usa os tokens sem mudar copy de custódia", async () => {
  const html = await readFile(new URL("../apps/cli/src/app/provider-setup.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--panel: #191A1D", "--accent: #F0CA6E", "--ink: #F0F0ED"]) {
    expect(html).toContain(token);
  }
  expect(html).toContain("protegida neste usuário do computador");
  expect(html).toContain('id="preset"');
  expect(html).toContain("/provider");
});

it("mark-web usa os tokens e segue às cegas", async () => {
  const html = await readFile(new URL("../apps/cli/src/mark-web/page.html", import.meta.url), "utf8");
  for (const token of ["--bg: #111214", "--accent: #F0CA6E"]) {
    expect(html).toContain(token);
  }
  for (const banned of ["transcript", "predi", "sugest", "melhor posição"]) {
    expect(html.toLowerCase()).not.toContain(banned);
  }
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run tests/redesign-surfaces.test.ts`
Expected: FAIL — tokens ausentes nas duas superfícies.

- [ ] **Step 3a: Tema escuro no `provider-setup.html` (só o `<style>`)**

Substituir TODO o conteúdo do `<style>` (cabeça do arquivo) por:

```html
<style>:root{--bg: #111214; --panel: #191A1D; --panel2: #202226; --line: #303238; --line-strong: #3A414B; --ink: #F0F0ED; --muted: #AAADB5; --accent: #F0CA6E; --on-accent: #1B1508; --red: #EFAAA0}body{font:16px system-ui;background:var(--bg);color:var(--ink);margin:0;padding:32px}main{max-width:520px;margin:5vh auto;background:var(--panel);padding:32px;border-radius:12px;border:1px solid var(--line)}label{display:block;margin:20px 0 6px;color:var(--muted)}input,select,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;background:var(--panel2);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px}button{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600;margin-top:24px;cursor:pointer}button:disabled{opacity:.45}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}p{line-height:1.5;color:var(--muted)}h1{font-size:20px}#error{color:var(--red)}</style>
```

Verificação obrigatória: `git diff apps/cli/src/app/provider-setup.html` deve mostrar APENAS a linha do `<style>` alterada.

- [ ] **Step 3b: Tokens no `:root` do `mark-web/page.html` (só o `:root`)**

Substituir o bloco `:root` (linhas 6–14) por:

```css
  :root {
    --bg: #111214; --panel: #191A1D; --panel2: #202226;
    --bg-0: var(--bg); --bg-1: var(--panel); --bg-2: var(--panel2);
    --line: #303238; --line-strong: #3A414B;
    --ink: #F0F0ED; --muted: #AAADB5; --faint: #7d8590;
    --accent: #F0CA6E; --on-accent: #1B1508;
    --green: #9FC9B2; --red: #EFAAA0;
    --warn: var(--red); --ok: var(--green);
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
    --sans-ui: system-ui, -apple-system, sans-serif;
  }
```

Verificação obrigatória: `git diff apps/cli/src/mark-web/page.html` mostra só o `:root`.

- [ ] **Step 4: Rodar testes**

Run: `pnpm vitest run tests/redesign-surfaces.test.ts apps/cli/src/mark-web apps/cli/src/app/provider-setup.test.ts`
Expected: PASS (suítes de peaks/server do mark-web e setup intactas).

- [ ] **Step 5: Prova visual**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
playwright-cli open http://127.0.0.1:7793/ && playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/redesign-T9-marcar.png
```

Expected: marcação com fundo grafite e acento dourado-fosco, onda hero, sem transcrição visível; comparar com `previews/10-mark.png`. (Setup não tem rota no serve.ts — validar por leitura do diff + teste.) `pnpm typecheck && pnpm lint` verdes.

- [ ] **Step 6: Commit**

```bash
git add tests/redesign-surfaces.test.ts apps/cli/src/app/provider-setup.html apps/cli/src/mark-web/page.html
git commit -m "feat(ui): setup e marcacao no tema grafite, contratos intactos"
```

---

### Task 10: Endurecimento + validação final (spec §7–§8)

**Files:**
- Create: `tests/redesign-contracts.test.ts`
- Modify: `apps/cli/src/app/assembly/page.js` (inspetor recolhido ≤1100px; revela na etapa entrega)
- Modify: `apps/cli/src/app/assembly/editor/contexto.js` (`#closeInspector` no inspetor)
- Modify: `apps/cli/src/app/assembly/page.css` (`.only-narrow`, `prefers-reduced-motion`)

**Interfaces:**
- Consumes: mapa `STAGE_TARGET` (Task 3); `#delivery` (Task 8); `watchedState(...).canApprove` no handler de aprovar (Task 5)
- Produces: fiação cruzada travada (shell↔módulos); proibição de atalhos de simulação; inspetor como overlay com abrir/fechar ≤1100px; `prefers-reduced-motion` respeitado

- [ ] **Step 1: Escrever os testes de contrato cruzado**

```ts
// tests/redesign-contracts.test.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const HTML = "../apps/cli/src/app/assembly/page.html";
const PAGEJS = "../apps/cli/src/app/assembly/page.js";
const CSS = "../apps/cli/src/app/assembly/page.css";
const RAIL = "../apps/cli/src/app/assembly/editor/rail.js";
const CONTEXTO = "../apps/cli/src/app/assembly/editor/contexto.js";
const TEXTO = "../apps/cli/src/app/assembly/editor/texto.js";
const SEQ = "../apps/cli/src/app/assembly/editor/sequencia.js";

async function read(p: string): Promise<string> {
  return readFile(new URL(p, import.meta.url), "utf8");
}

it("fiação shell↔módulos: regiões e ids dinâmicos existem", async () => {
  const html = await read(HTML);
  for (const id of ["topbar", "stages", "tools", "rail", "center", "stage", "texto", "contexto", "faixa", "status", "previewPlayer", "openBriefing", "dropzone", "filePicker"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const js = (await Promise.all([PAGEJS, RAIL, CONTEXTO, TEXTO, SEQ].map(read))).join("\n");
  for (const id of ["briefingDialog", "prepDialog", "delivery", "sourceCounts", "inspectorState", "deliveryChecklist", "versionHistory", "opLine", "closeInspector"]) {
    expect(js).toContain(id);
  }
  expect(js).toContain('materiais: "rail"');
  expect(js).toContain('entrega: "delivery"');
});

it("aprovação no front continua condicionada ao assistido real", async () => {
  const contexto = await read(CONTEXTO);
  expect(contexto).toContain("watchedState(project, watched).canApprove");
  expect(contexto).not.toContain("Simular reprodu");
});

it("protótipo não vaza para produção", async () => {
  const all = (await Promise.all([HTML, PAGEJS, RAIL, CONTEXTO, TEXTO, SEQ].map(read))).join("\n");
  expect(all).not.toContain("Decupa.create");
  expect(all).not.toContain("decupa-redesign");
});

it("inspetor estreito tem abrir/fechar + reduced-motion", async () => {
  const pagejs = await read(PAGEJS);
  const css = await read(CSS);
  expect(pagejs).toContain("matchMedia");
  expect(css).toContain(".only-narrow");
  expect(css).toContain("prefers-reduced-motion");
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm vitest run tests/redesign-contracts.test.ts`
Expected: FAIL em `closeInspector` (ainda não existe) e `matchMedia`/`prefers-reduced-motion`.

- [ ] **Step 3a: Inspetor overlay com abrir/fechar (≤1100px)**

1. Em `mountContexto` (`contexto.js`), após criar `#inspectorState` (Task 5), inserir:

```js
  const closeInspector = document.createElement("button");
  closeInspector.type = "button";
  closeInspector.id = "closeInspector";
  closeInspector.className = "only-narrow";
  closeInspector.textContent = "Fechar inspetor";
  closeInspector.addEventListener("click", () => { root.hidden = true; });
  root.appendChild(closeInspector);
```

2. Em `page.js`, no handler do `#stages` (Task 3), após `scrollIntoView`, inserir:

```js
  if (window.matchMedia("(max-width: 1100px)").matches && button.dataset.stage === "entrega") {
    document.getElementById("contexto").hidden = false;
  }
```

3. Em `page.js`, após o bloco de mounts/fiação (Task 3), inserir o recolhido inicial:

```js
if (window.matchMedia("(max-width: 1100px)").matches) {
  document.getElementById("contexto").hidden = true;
}
```

- [ ] **Step 3b: CSS `.only-narrow` + `prefers-reduced-motion`** (anexar ao `page.css`):

```css
.only-narrow { display: none; }
@media (max-width: 1100px) { .only-narrow { display: inline-flex; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
```

- [ ] **Step 4: Validação estática completa**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: tudo verde.

- [ ] **Step 5: Validação de viewports (sem overflow horizontal externo)**

```bash
kill $(cat work/ui-screens/serve.log) 2>/dev/null; node work/ui-screens/serve.ts &
for vp in "1440 900" "1280 800" "1024 768" "390 844"; do
  set -- $vp
  playwright-cli open http://127.0.0.1:7792/ && playwright-cli resize $1 $2
  playwright-cli eval "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
  playwright-cli screenshot --filename=png/redesign-T10-montar-$1.png
done
```

Expected: `true` nas 4 avaliações (mesmo critério do `validation.json` do protótipo); 4 PNGs. Repetir o `open` em 7791/7793 para 1440px e conferir `previews/02-transcript.png` e `previews/10-mark.png`.

- [ ] **Step 6: QA funcional com mídia real (spec §8, manual)**

Com o app real (`pnpm decupa` ou `startApp` com mídia local — NÃO o mock do serve.ts): importar gravações reais, localizar um trecho pelo texto, limpar uma repetição (Tirar), restaurar a decisão, atualizar a prévia, assistir até o fim, aprovar e exportar. Registrar onde houver hesitação vs. a versão base (prints T1). Critérios de aceite: nenhum resultado disponível se perde; resposta atrasada não sobrescreve versão nova (editar durante "Atualizando prévia…" e conferir `data-rev`); aprovação indevida bloqueada (botão desabilitado antes de assistir); export com revisão identificável nos links.

- [ ] **Step 7: Commit**

```bash
git add tests/redesign-contracts.test.ts apps/cli/src/app/assembly/page.js apps/cli/src/app/assembly/editor/contexto.js apps/cli/src/app/assembly/page.css
git commit -m "feat(ui): endurecimento e validacao final da bancada"
```

---

## Mapa spec → plano (rastreabilidade)

| Spec | Coberto em |
|---|---|
| §6 Etapa A (base + contratos) | Task 1 (branch, travas, prints base) |
| §6 Etapa B (bancada, mesmo motor) | Tasks 2–6 (tokens, shell, rail, palco/inspetor, timeline) |
| §6 Etapa C (texto/triagem) | Task 7 (docSignature, scroll/foco, limpeza) |
| §6 Etapa D (prep/recuperação/entrega) | Task 8 (`#opLine`, cancelar honesto, entrega + formatos + versões) |
| §6 Etapa E (setup + marcação) | Task 9 (tema, contratos intactos) |
| §6 Etapa F (web: acesso/projetos/biblioteca/fila) | FORA DESTE PLANO — plano separado futuro (depende de backend inexistente) |
| §5 aprovação/watched | Tasks 1 (trava), 5 (move verbatim), 10 (pin `canApprove`) |
| §5 auto-prévia/debounce/409 | Intocado por construção (page.js lógica fora de edição); Tasks 3/8 validam via `assembly-flow/delivery` |
| §5 marcação às cegas | Task 9 (teste proíbe transcript/predição/sugestão) |
| §5 export por capacidade | Task 8 (formatos na montagem; limpeza mantém os 4) |
| §5 sem "pausar" falso | Task 8 ("Cancelar preparação") |
| §7 a11y/perf | Task 7 (sem rebuild), Task 10 (overlay, Esc nativo, reduced-motion, foco visível já global) |
| §8 validação | Task 10 (4 viewports, QA com mídia real) |
| Telas 01–11 do protótipo | Cobertas (editor, transcrição, sugestões→triagem existente, importação→materiais/briefing, preparação, falha→prep+opLine, revisão, exportação, conclusão→exportado✓, marcação, IA/config→setup) |
| Telas 12–16 (projetos, vazio web, biblioteca, fila, login) | Etapa F — fora deste plano |
| `core.js` do protótipo como motor | EXPLICITAMENTE PROIBIDO (Task 10 trava ausência) |
| Botão "Simular reprodução" | EXPLICITAMENTE PROIBIDO (Task 10 trava ausência + gate) |
| Refazer (redo), zoom da timeline, seletor de proporção | Protótipo-only — sem contrato no backend; Task 6 documenta como não-metas |
| Diálogos de ajuda e mapa das telas | Protótipo-only (chrome de navegação da demo); onboarding coberto pelo guia vazio preservado (Task 7) |
