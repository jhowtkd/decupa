# Redesign das telas do decupa — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar o sistema visual "sala de corte" (docs/redesign-telas/redesign.md) às três telas web do decupa — limpar, montar, marcar — sem mudar comportamento.

**Architecture:** As três telas são HTML self-contained servidos por servidores Node embutidos no CLI (`apps/cli/src/app/server.ts`, `apps/cli/src/app/assembly/routes.ts`, `apps/cli/src/mark-web/server.ts`). O redesign é CSS + markup + ajustes cirúrgicos no JS de render; nenhum endpoint muda. Tokens ficam inline em cada página (filosofia self-contained do app; sem CDN, sem nova dependência). O editor de montagem é o único com CSS externo (`page.css`) e módulos JS (`editor/*.js`).

**Tech Stack:** Node 22+ com `--experimental-strip-types`, HTML/CSS/JS vanilla, vitest, playwright-cli para prova visual.

**Spec:** `docs/redesign-telas/redesign.md` (ler antes de executar; o plano argumenta a partir dele).

## Global Constraints

Vale para TODAS as tarefas, implicitamente.

### Branch e git

- Trabalhe na branch `redesign-telas` (criada na Task 1 a partir de `main`).
- A árvore tem arquivos MODIFICADOS POR OUTRO TRABALHO (`apps/cli/src/app/pipeline.ts`, `apps/cli/src/app/pipeline.test.ts`, `apps/cli/src/app/assembly/analysis.test.ts`, `packages/triage/src/speech-index.*`). NUNCA rode `git add -A` nem `git add .`. Faça stage apenas dos arquivos que a sua tarefa tocou, pelo nome.
- Um commit por task, mensagem convencional em pt-BR (ex.: `feat(ui): header da tela de limpeza`).

### Verificação (toda task termina com isto verde)

```bash
pnpm vitest run        # suíte inteira
pnpm typecheck         # tsc --noEmit
```

Prova visual (receita única; tirar screenshots em `work/ui-screens/png/`):

```bash
node work/ui-screens/serve.ts &        # limpar 7791 · montar 7792 · marcar 7793
playwright-cli open http://127.0.0.1:7791/
playwright-cli resize 1440 900
playwright-cli screenshot --filename=png/tarefa-N-limpar.png
```

- `limpar` e `marcar` leem o `page.html` UMA vez no boot do servidor: depois de editar esses arquivos, **mate e suba o serve.ts de novo** (`kill <pid>`; o pid está em `work/ui-screens/serve.log`).
- `montar`: `page.css` E `editor/*.js` são lidos no boot e cacheados em memória (correção de campo, Tasks 3 e 5) — edite qualquer um deles e **reinicie o serve.ts**.
- Compare o print com o mockup `docs/redesign-telas/mockups/montar.html` e os prints atuais em `docs/redesign-telas/telas/`.

### Tokens canônicos (colar em cada `<style>`/page.css que a task tocar)

```css
:root {
  --bg-0: #111316; --bg-1: #181B20; --bg-2: #20242B;
  --line: #2B3038; --line-strong: #3A414B;
  --ink: #E9E7E2; --muted: #9AA0A9; --faint: #6B7280;
  --accent: #F2C230; --on-accent: #1B1508;
  --warn: #E0765C; --ok: #63BE97;
  --serif: Charter, "Iowan Old Style", Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
```

Substituir os tokens antigos (`--bg`, `--panel`, `--line` teal) pelos novos: `--bg → --bg-0`, `--panel → --bg-1`, superfícies elevadas → `--bg-2`. Manter os NOMES antigos como alias só onde o arquivo usa muito (`--bg: var(--bg-0)` é aceitável para não tocar em dezenas de usos; preferir renomear quando o toque for pequeno).

### Sistema de botões (restyle no seletor base, sem classe nova obrigatória)

```css
button {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 12px; border-radius: 6px;
  font: 600 13px/1 var(--sans-ui, system-ui); color: var(--ink);
  background: var(--bg-2); border: 1px solid var(--line-strong); cursor: pointer;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.quiet { background: transparent; border-color: transparent; color: var(--muted); }
button.quiet:hover { color: var(--ink); }
button.danger { background: transparent; border-color: transparent; color: var(--warn); }
button:disabled { opacity: .45; cursor: default; }
button:active:not(:disabled) { transform: translateY(1px); }
```

Exceção: botões de palavra dentro da prosa (`.word`, `.play`, `.u`) NÃO recebem este chrome — continuam inline invisíveis.

### Regras de tipo (três papéis)

- **Material** (prosa que se edita): `font-family: var(--serif); font-size: 19-20px; line-height: 1.65;` — só `#prosa` (limpar) e `.prose` (montar).
- **Interface**: sans de sistema 13-14px — todo o resto.
- **Dados**: `font-family: var(--mono); font-variant-numeric: tabular-nums;` 12-13px — timecodes, contagens, durações, revisões.

### Integridade (não negociável)

- Nenhum `id` usado por JS pode sumir ou ser renomeado sem atualizar o JS no mesmo commit. Nenhum handler de teclado pode mudar. Atributos aria permanecem.
- Zero em-dash (`—`) em copy de interface. Separador `·` no máximo 1 por linha.
- Nenhuma dependência nova de fonte/ícone/CDN. Glifos unicode padronizados: `⋮` (kebab), `▶` (play), `⟳` (atualizar), `✓` (ok).
- Copy em pt-BR, minúsculas, mesma voz do app atual.
- Se um teste referenciar seletor/classe renomeado pela task, atualize o SELETOR no teste; comportamento testado não muda.

---

### Task 1: Limpar — header com hierarquia, stats em dados, menu de exportar

**Files:**
- Modify: `apps/cli/src/app/page.html` (CSS no `<style>`, markup do `<header>`, JS: `render()`, `readyFrom()`, loop de export no fim do arquivo)

**Interfaces:**
- Produces: botões de export passam a ser `[data-export]` com `dataset.export ∈ {"edl","mp4","srt","transcript"}` (mesmos valores do POST `/jobs/:id/export` de hoje). Stats: ids `kept-count`, `total-count`, `out-sec`, `src-sec` dentro de `#stage`.

- [ ] **Step 1: Criar a branch**

```bash
git checkout -b redesign-telas
```

- [ ] **Step 2: Substituir os tokens no `<style>`**

Troque o bloco `:root` atual (linhas ~7-9) pelo bloco canônico de Global Constraints + adicione `--sans-ui: system-ui, -apple-system, sans-serif;`. Atualize os usos: `var(--bg) → var(--bg-0)`, `var(--panel) → var(--bg-1)`, `#fff0d`-style hextints de hover podem ficar. Cole o sistema de botões de Global Constraints (o `button` base atual do arquivo é parecido; substitua pelo novo).

- [ ] **Step 3: Novo markup do `<header>`**

Substitua o header atual (linhas ~118-133) por:

```html
<header data-mode="process">
  <span class="brand">decupa</span>
  <span class="crumb">limpar fala</span>
  <span id="stage" class="stats" hidden>
    <b id="kept-count">0</b><span class="dim">/</span><span id="total-count">0</span> trechos
    <span class="sep"></span>
    <b id="out-sec">0</b>s <span class="dim">de</span> <span id="src-sec">0</span>s
  </span>
  <span id="aviso"></span>
  <span class="spacer"></span>
  <button id="cancelar" class="danger">cancelar</button>
  <button id="triar" disabled>sugerir cortes</button>
  <div class="export-wrap">
    <button id="exportar" class="primary" disabled>exportar</button>
    <div id="export-menu" hidden>
      <button data-export="edl">timeline .edl</button>
      <button data-export="mp4">vídeo .mp4</button>
      <button data-export="srt">legendas .srt</button>
      <button data-export="transcript">transcrição .txt</button>
    </div>
  </div>
</header>
```

CSS novo do header (substituir o bloco `header {…}` e `header[data-mode]`):

```css
header {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 14px;
  padding: 10px 16px; border-bottom: 1px solid var(--line);
  background: var(--bg-1); font-family: var(--sans-ui); font-size: 13px;
}
header .brand { font-weight: 700; }
header .crumb { color: var(--muted); }
header .spacer, header .export-wrap { margin-left: 0; }
header .spacer { flex: 1; }
header[data-mode="process"] .crumb { display: none; }
.stats { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted); }
.stats b { color: var(--ink); font-size: 16px; font-weight: 600; }
.stats .sep { display: inline-block; width: 1px; height: 14px; background: var(--line-strong); margin: 0 8px; vertical-align: -2px; }
.stats .dim { color: var(--faint); }
.export-wrap { position: relative; }
#export-menu {
  position: absolute; right: 0; top: 38px; z-index: 3; min-width: 180px;
  background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 10px;
  padding: 4px; display: flex; flex-direction: column;
}
#export-menu button {
  background: none; border: none; height: 30px; border-radius: 6px;
  font: 500 13px var(--sans-ui); color: var(--ink); justify-content: flex-start;
}
#export-menu button:hover { background: var(--bg-1); }
```

- [ ] **Step 4: JS — stats e export**

Em `render()` (fim da função), troque o bloco `el("stage").textContent = …` por:

```js
el("kept-count").textContent = review.units.filter((u) => kept.get(u.id)).length;
el("total-count").textContent = review.units.length;
el("out-sec").textContent = review.outputSeconds.toFixed(0);
el("src-sec").textContent = review.sourceSeconds.toFixed(0);
el("stage").hidden = false;
```

ATENÇÃO: `renderProcessing()` e `renderMessage()` começam com `el("stage").textContent = "";` — isso APAGARIA os spans novos do stats. Troque essas duas linhas por:

```js
el("stage").hidden = true;
```

Em `readyFrom()`, troque a linha dos ids habilitados por:

```js
for (const id of ["triar", "exportar"]) el(id).disabled = false;
```

Troque o loop de export do fim do arquivo por:

```js
const exportMenu = el("export-menu");
el("exportar").onclick = () => { exportMenu.hidden = !exportMenu.hidden; };
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".export-wrap")) exportMenu.hidden = true;
});
for (const btn of exportMenu.querySelectorAll("[data-export]")) {
  const kind = btn.dataset.export;
  btn.onclick = async () => {
    exportMenu.hidden = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "exportando…";
    try {
      const r = await api("/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, keepList: keepList() }),
      });
      if (r.error) { toast(r.error, true); return; }
      toast("download a caminho");
      location.href = r.downloadUrl;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}
```

- [ ] **Step 5: Verificar**

```bash
pnpm vitest run apps/cli/src/app/server.test.ts
```

Suba o harness (restart se já rodando), abra `http://127.0.0.1:7791/`, screenshot `png/tarefa-1-limpar-header.png`. Esperado: brand à esquerda, stats em mono grande, `cancelar` esmaecido vermelho, `sugerir cortes` secundário, `exportar` âmbar abrindo menu com 4 alvos; exports baixam de verdade (clique num alvo e veja o toast).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/page.html
git commit -m "feat(ui): header da tela de limpeza com hierarquia e menu de export"
```

---

### Task 2: Limpar — prosa material, cortes inline, junções numeradas, prévia da triagem

**Files:**
- Modify: `apps/cli/src/app/page.html` (CSS: `#prosa`, `.u`, `.gone`, `.join`, `#triage`; JS: `render()` bloco do `.gone`, `joinNode()`)

**Interfaces:**
- Consumes: tokens/botões da Task 1.
- Produces: `.gone` passa a ser texto inline riscado (sem `.gone-text`); `.join` ganha contador de corte (`corte N`) e duração removida em mono.

- [ ] **Step 1: CSS da prosa e dos cortes**

No `<style>`, substitua os blocos `.u`, `.gone`, `.gone .gone-text`, `#prosa` por:

```css
main { max-width: none; padding: 40px 24px 180px; }
#prosa {
  max-width: 34em; margin: 0 auto;
  font-family: var(--serif); font-size: 20px; line-height: 1.65;
}
.u { position: relative; cursor: pointer; border-radius: 3px; transition: background 90ms; }
.u:hover { background: #e0765c26; box-shadow: 0 0 0 2px #e0765c26; }
.gone {
  color: var(--faint);
  text-decoration: line-through; text-decoration-color: var(--warn); text-decoration-thickness: 1.5px;
  cursor: pointer; border-radius: 3px;
}
.gone:hover { color: var(--muted); background: #ffffff0d; }
```

Mantenha os blocos `.u .play` e `.gone .play` como estão (ouvir no hover).

- [ ] **Step 2: JS — corte inline**

Em `render()`, no ramo `else` (não-kept), substitua a criação do chip por:

```js
const mark = document.createElement("span");
mark.className = "gone";
mark.textContent = u.text;   // inteiro: o risco mostra tudo, sem elipse
```

(O `title` de restaurar e o `playBtn` ficam como estão; apague o `span.gone-text`.)

- [ ] **Step 3: JS — junção numerada**

`joinNode(join)` recebe também o número do corte. Mude a assinatura para `joinNode(join, n)` e a chamada em `render()` para `main.append(joinNode(join, ++joinCount))` (declare `let joinCount = 0;` antes do loop e zere a cada `render()`). Primeira linha do box:

```js
const head = document.createElement("span");
head.className = "join-head";
head.textContent = `corte ${n}`;
const dur = document.createElement("span");
dur.className = "join-dur";
dur.textContent = ` -${join.removedSeconds.toFixed(1).replace(".", ",")}s`;
head.append(dur);
box.append(head);
```

- [ ] **Step 4: CSS da junção e da prévia da triagem**

```css
.join { display: block; margin: 16px 0; font-family: var(--sans-ui); font-size: 12.5px; }
.join-head {
  display: inline-flex; align-items: center; gap: 6px;
  font: 600 11px var(--mono); letter-spacing: .06em; text-transform: uppercase;
  color: var(--faint); border-left: 2px solid var(--line-strong); padding-left: 8px;
}
.join .flag { color: var(--warn); display: block; padding: 2px 0 0 10px; border-left: 2px solid var(--warn); }
.join .play { color: var(--accent); }
.join-dur { color: var(--warn); text-transform: none; letter-spacing: 0; }
#triage {
  position: sticky; bottom: 0; z-index: 2;
  background: var(--bg-1); border-top: 1px solid var(--line);
  padding: 18px 22px 20px; font-family: var(--sans-ui); font-size: 13px;
  max-height: 46vh; overflow: auto;
}
#triage h2 { margin: 0; font-size: 14px; }
#triage .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin-top: 6px; }
#triage .lbl { color: var(--muted); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; margin: 12px 0 4px; }
#triage ul { margin: 0; padding: 0; list-style: none; }
#triage li { margin: 3px 0; color: var(--ink); }
#triage .actions { display: flex; gap: 8px; margin-top: 14px; }
@media (max-width: 760px) { #triage .cols { grid-template-columns: 1fr; } }
```

No markup do `#triage`, envolva as duas listas num `<div class="cols">` (`vai cair` à esquerda, `olhe isto` à direita) e troque o `#triage-stats` para `class="lbl data"` (mono). Em `renderProcessing()`, adicione antes do `<ol>` três barras de skeleton:

```js
const skel = document.createElement("div");
skel.className = "skeleton";
for (let i = 0; i < 3; i++) skel.append(document.createElement("span"));
el("prosa").append(skel);
```

```css
.skeleton { max-width: 34em; margin: 0 auto 22px; display: flex; flex-direction: column; gap: 12px; }
.skeleton span { height: 14px; border-radius: 4px; background: var(--bg-2); animation: pulse 1.2s ease-in-out infinite; }
.skeleton span:nth-child(2) { width: 88%; }
.skeleton span:nth-child(3) { width: 62%; }
@keyframes pulse { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .skeleton span { animation: none; } }
```

- [ ] **Step 5: Verificar**

`pnpm vitest run apps/cli/src/app/server.test.ts` + restart do serve.ts + screenshot `png/tarefa-2-limpar-prosa.png` (review) e `png/tarefa-2-limpar-triagem.png` (clicar `sugerir cortes`). Esperado: prosa serifada em medida de leitura, cortes riscados inline em cinza com risco terracota, marcadores `corte 1 -6,4s`, prévia em duas colunas com `aplicar` âmbar.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/page.html
git commit -m "feat(ui): prosa material e cortes inline na tela de limpeza"
```

---

### Task 3: Montar — tema dark (flip de page.css)

**Files:**
- Modify: `apps/cli/src/app/assembly/page.css` (arquivo inteiro)

**Interfaces:**
- Produces: tokens dark + classes `.chip`, `.panel-label`, `button.quiet/danger`, superfícies `--bg-0/1/2` — Tasks 4, 5 e 6 consomem. NENHUM seletor de estrutura muda (`.source`, `.prep-file`, `.stage.*`, `.word.*`, `.scene-head`, `.prose` continuam existindo).

- [ ] **Step 1: Reescrever page.css**

Mantenha TODA a estrutura de seletores e regras de layout (grid do body, áreas, media queries, `.word`, `.stage`, `#dropzone` etc.) e troque apenas: tokens (canônicos), superfícies (`--bg → var(--bg-0)`, `--panel → var(--bg-1)`), o bloco `button` (Global Constraints), e estes pontos:

```css
:root {
  --bg-0: #111316; --bg-1: #181B20; --bg-2: #20242B;
  --bg: var(--bg-0); --panel: var(--bg-1);   /* aliases: o arquivo usa muito */
  --line: #2B3038; --line-strong: #3A414B;
  --ink: #E9E7E2; --muted: #9AA0A9; --faint: #6B7280;
  --accent: #F2C230; --on-accent: #1B1508;
  --ok: #63BE97; --warn: #E0765C;
  --removed: #3a2a26; --protected: #26374a;
  --serif: Charter, "Iowan Old Style", Georgia, serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans-ui: system-ui, -apple-system, sans-serif;
}
button.primary { color: var(--on-accent); }
button.quiet { background: transparent; border-color: transparent; color: var(--muted); }
button.danger { background: transparent; border-color: transparent; color: var(--warn); }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, .word:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
textarea, input, select { background: var(--bg-2); color: var(--ink); border-color: var(--line-strong); }
.card { background: var(--bg-2); border-color: var(--line); }
a { color: var(--accent); }
video { background: #000; border-radius: 10px; }
.word:hover { background: var(--bg-2); }
.word[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
.word.riscado { background: var(--removed); }
#dropzone { background: var(--bg-0); }
```

Adicione os primitivos que as Tasks 4-6 usam:

```css
.panel-label { font: 600 11px var(--sans-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 6px;
  background: var(--bg-1); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--muted);
}
```

Mantenha o `@media (prefers-reduced-motion)` do fim.

- [ ] **Step 2: Verificar**

`pnpm vitest run` inteiro + reload do montar (sem restart) + screenshot `png/tarefa-3-montar-dark.png`. Esperado: as 4 regiões escuras na rampa quente, nada ilegível, nenhum resquício claro (procurar manchas `#f4f2ec`/`#ffffff` no CSS e matar).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/app/assembly/page.css
git commit -m "feat(ui): tema escuro unificado no editor de montagem"
```

---

### Task 4: Montar — rail (materiais, preparação, briefing) e contexto em cards

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/rail.js` (render de materiais/preparação/briefing/entrega)
- Modify: `apps/cli/src/app/assembly/editor/contexto.js` (chips de meta, notas)
- Modify: `apps/cli/src/app/assembly/page.css` (styles novos da Task)

**Interfaces:**
- Consumes: tokens/`.chip`/`.panel-label` da Task 3.
- Produces: rail marca seleção com `classList.toggle("has-selection", …)` no `#rail`; CSS `.has-selection .rail-actions { display: flex; }`.

- [ ] **Step 1: CSS do rail/contexto**

Acrescente a page.css:

```css
#rail, #contexto { padding: 14px; }
.source {
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px;
  padding: 10px; margin: 8px 0; align-items: center;
}
.source img { width: 64px; border-radius: 6px; }
.source .controls { margin-top: 8px; }
.source select { background: var(--bg-1); border-radius: 6px; }
.rail-actions { display: none; gap: 6px; margin: 8px 0; }
#rail.has-selection .rail-actions { display: flex; }
.rail-head h1 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin: 0 0 10px; }
.delivery a { display: inline-flex; margin-right: 10px; }
#downloads .data, .delivery .data { font-family: var(--mono); font-size: 12px; }
.preview-meta { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
```

- [ ] **Step 2: rail.js — material como card e barra contextual**

Em `renderSources(project)` (rail.js:113), troque o bloco `name.textContent = source.name + " · " + …` pela estrutura nome + chips:

```js
const name = document.createElement("div");
name.className = "m-name";
name.textContent = source.name;
const meta = document.createElement("div");
meta.className = "m-meta";
meta.append(chip(Math.round(source.durationSeconds) + "s"));
if (!source.included) meta.append(chip("excluída"));
if (analysis) meta.append(chip(analysis.status));
```

com `const chip = (t) => { const s = document.createElement("span"); s.className = "chip"; s.textContent = t; return s; };` no topo do módulo (o `meta.className = "meta"` antigo some; o `.meta` que envolve nome continua). Na `renderBatchButtons()` (rail.js:106), depois dos três `setDisabled`, adicione:

```js
document.getElementById("rail").classList.toggle("has-selection", any);
```

Os botões do `controls` mantêm ids/handlers; `excluir`/`ver original` ganham `className = "quiet"` (o toggle incluir/excluir fica no estilo base). Os títulos `<h1>` das seções (Materiais/Briefing/Preparação/Entrega) continuam `<h1>` — o CSS da Task já os transforma em panel-label.

- [ ] **Step 3: rail.js — briefing recolhido e entrega**

O bloco Briefing (`briefing.innerHTML` em rail.js:59-65, com `#kind`, `#inputText`, `#target`, `#saveInput`) vira `<details id="briefing-box">` com `<summary class="panel-label">briefing</summary>` envolvendo o conteúdo (ids mantidos). No render que recebe `project` e popula `#sources`/`#prepList`, acrescente o empty state:

```js
const box = document.getElementById("briefing-box");
if (box) box.open = project.assembly.sources.length === 0;
```

Ou seja: projeto sem fontes abre o briefing sozinho (primeiro gesto = colar o roteiro e arrastar mídia). A entrega (`renderDelivery`) mantém o cadeado; links `timeline.otio`/`reference.mp4` ganham `class="data"`.

- [ ] **Step 4: contexto.js — chips de prévia**

Onde hoje há texto solto de prévia ("Prévia revisão X — atualizando…", "prévia N · final null · WxH @ fps"), renderize chips:

```js
meta.replaceChildren(
  chip(`prévia ${p.previewRevision}`),
  chip(`${seconds}s`),
  chip(`${p.assembly.width}×${p.assembly.height} @ ${fps}`),
);
```

com `const chip = (t) => { const s = document.createElement("span"); s.className = "chip"; s.textContent = t; return s; };` no topo do módulo. Botões ganham classes: `atualizar prévia` fica como está (secundário base), `aprovar prévia assistida` já é `.primary` (manter trava atual), `propor mudanças` `.primary`, `cancelar` da preparação `.danger`.

- [ ] **Step 5: Verificar**

`pnpm vitest run` + reload + screenshots `png/tarefa-4-montar-rail.png` e `png/tarefa-4-montar-contexto.png`. Esperado: cards de material com thumb e chips; barra de ações em lote só aparece com seleção; briefing recolhido; prévia com linha de chips mono.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/rail.js apps/cli/src/app/assembly/editor/contexto.js apps/cli/src/app/assembly/page.css
git commit -m "feat(ui): rail e contexto do editor em cards no tema escuro"
```

---

### Task 5: Montar — texto: cenas com hierarquia, prosa material, zonas omitidas

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/texto.js` (scene-head, chip de fonte, zonas omitidas)
- Modify: `apps/cli/src/app/assembly/page.css` (`.prose` serif, `.scene-head`, `.src-chip`, `.unused`)
- Test: `apps/cli/src/app/assembly/texto.test.ts` (ajustar seletores se referenciarem markup mudado)

**Interfaces:**
- Consumes: `.chip`, serif tokens da Task 3.
- Produces: scene-head com `data-scene` preservado (o clique/edição continua via delegação atual); `.word` e suas classes (`riscado`, `protected`, `corrected`, `aria-pressed`) intocados.

- [ ] **Step 1: CSS**

```css
#texto { padding: 28px 48px 140px; }
#texto .measure { max-width: 620px; margin: 0 auto; }
.prose { font-family: var(--serif); font-size: 20px; line-height: 1.65; }
.scene-head {
  display: flex; align-items: baseline; gap: 10px;
  border-bottom: 1px solid var(--line); padding-bottom: 8px; margin: 30px 0 14px;
}
.scene-head .num { font: 600 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.scene-head .title { font: 600 15px var(--sans-ui); color: var(--ink); }
.take .src, .src-chip {
  display: inline-flex; margin-top: 10px; padding: 2px 8px;
  border-radius: 6px; background: var(--bg-1); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 11.5px; color: var(--muted);
}
.unused {
  margin-top: 12px; border: 1px dashed var(--line-strong); border-radius: 10px;
  padding: 10px 12px; color: var(--faint); font-size: 12.5px;
}
.unused .prose { font-size: 15px; color: var(--muted); }
```

- [ ] **Step 2: texto.js — scene-head**

Onde a cena renderiza o cabeçalho (função que monta `.scene-head`), produza:

```js
head.replaceChildren(
  span("num", `cena ${n}`),
  span("title", scene.objective || ""),
  spacer(),
  span("chip", `${firstStart}-${lastEnd}s`),
);
```

com `n` = índice da cena + 1 e `firstStart/lastEnd` em segundos vindos dos takes (mesmos números que hoje aparecem em `fala.mp4 · 0.4s-25.2s`; mantenha `data-scene`). O rótulo de fonte (`fala.mp4`) desce para o `.src-chip` no fim do bloco da cena, junto do que hoje é `.take .src`. Os botões ↥↧/× do cabeçalho ficam, como `button.quiet`, após o chip.

- [ ] **Step 3: texto.js — zonas omitidas como inset**

O bloco "fora da montagem" (`Zona omitida`/`fora da montagem` no build do doc, linha ~267-272) vira:

```js
const box = document.createElement("div");
box.className = "unused";
const label = document.createElement("span");
label.textContent = `não usado (${wordCount} palavras)`;
const incluir = document.createElement("span");
incluir.className = "chip";
incluir.textContent = "incluir trecho";
box.append(label, incluir);
```

A prosa omitida continua dentro do box (mesmos handlers de ouvir/incluir), apenas apagada (`color: var(--muted)`). `wordCount` = número de `.word` do bloco (conte ao montar).

- [ ] **Step 4: Correção de grafia**

`.word.corrected` mantém itálico; adicione `border-bottom: 2px dotted var(--accent);` para o overlay alinhado. Nada de JS.

- [ ] **Step 5: Verificar**

`pnpm vitest run` (se `texto.test.ts` quebrar em seletor de cabeçalho, atualize o seletor) + reload + screenshot `png/tarefa-5-montar-texto.png`. Esperado: prosa serifada 20px, cabeçalhos `cena 1 · Gancho e promessa …… 0.4-25.2s ⋮`, chips de fonte, inset "não usado".

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/editor/texto.js apps/cli/src/app/assembly/page.css apps/cli/src/app/assembly/texto.test.ts
git commit -m "feat(ui): texto do editor com cenas hierárquicas e prosa material"
```

---

### Task 6: Montar — faixa como timeline (régua + blocos + playhead com timecode)

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/sequencia.js` (rulerTicks + render da régua + playhead ao play)
- Modify: `apps/cli/src/app/assembly/page.css` (faixa 88px)
- Test: `apps/cli/src/app/assembly/sequencia.test.ts`

**Interfaces:**
- Consumes: `blocksAt(project, seconds)` e `seekFromRatio(project, ratio)` já exportados.
- Produces: `rulerTicks(durationSeconds, targetCount)` → `number[]` crescente começando em 0, passo "nice" (1/2/5×10^n), último ≤ duração.

- [ ] **Step 1: Teste falhando**

Acrescente em `sequencia.test.ts`:

```ts
import { rulerTicks } from "./sequencia.js";

it("rulerTicks gera passos nice de 0 até a duração", () => {
  expect(rulerTicks(73.1, 6)).toEqual([0, 20, 40, 60]);
  expect(rulerTicks(95.4, 6)).toEqual([0, 20, 40, 60, 80]);
  expect(rulerTicks(9, 6)).toEqual([0, 2, 4, 6, 8]);
  expect(rulerTicks(0, 6)).toEqual([0]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
pnpm vitest run apps/cli/src/app/assembly/sequencia.test.ts
```

Esperado: FAIL (`rulerTicks is not a function`).

- [ ] **Step 3: Implementar**

Em `sequencia.js`, junto dos outros exports:

```js
export function rulerTicks(durationSeconds, targetCount = 6) {
  if (!(durationSeconds > 0)) return [0];
  const raw = durationSeconds / targetCount;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks = [];
  for (let s = 0; s <= durationSeconds + 1e-9; s += step) ticks.push(s);
  return ticks;
}
```

- [ ] **Step 4: Rodar e ver passar**

Mesmo comando do Step 2. Esperado: PASS.

- [ ] **Step 5: Render da régua e do playhead**

Em `render(p)` (sequencia.js:90), depois de `const duration = montageDuration(p);`, construa a régua e inclua no replaceChildren:

```js
const ruler = document.createElement("div");
ruler.className = "ruler";
for (const t of rulerTicks(duration)) {
  const s = document.createElement("span");
  s.textContent = t === 0 ? "0s" : String(t);
  ruler.append(s);
}
// ...
el.replaceChildren(ruler, strip, transportRow(p));
```

A cabeçalho da faixa (`faixa-head` com `panel-label` "Sequência" e o total em mono) entra acima da régua no mesmo replaceChildren. Na função `paint(t)` (sequencia.js:~226, subscrição em `state.subscribe("playhead", …)`), além do posicionamento atual, escreva o chip de tempo no playhead:

```js
let chip = playheadEl.querySelector(".t");
if (!chip) { chip = document.createElement("span"); chip.className = "t"; playheadEl.append(chip); }
if (valid) chip.textContent = t.toFixed(1).replace(".", ",") + "s";
```

(`playheadEl` é o elemento `.seq-playhead` já resolvido na função; `valid` é a condição que hoje posiciona o playhead.) A waveform dos blocos NÃO muda: os `<canvas class="seq-wave">` já existem e são hidratados por `hydrateWaves` — mantenha. Acrescente apenas a duração do bloco no template do `seq-bloco`, junto do `title`:

```js
+ '<span class="data dur">' + (block.end - block.start).toFixed(1).replace(".", ",") + "s</span>"
```

- [ ] **Step 6: CSS da faixa**

```css
#faixa { min-height: 88px; padding: 8px 14px 10px; display: flex; flex-direction: column; gap: 4px; }
#faixa .faixa-head { display: flex; justify-content: space-between; align-items: center; }
#faixa .ruler { display: flex; justify-content: space-between; }
#faixa .seq-strip { gap: 3px; }
.seq-bloco .dur { position: absolute; right: 6px; top: 5px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.seq-playhead { width: 2px; background: var(--accent); z-index: 1; }
.seq-playhead .t {
  position: absolute; top: -18px; left: 50%; transform: translateX(-50%);
  background: var(--accent); color: var(--on-accent);
  font: 600 10.5px var(--mono); padding: 1px 5px; border-radius: 4px; white-space: nowrap;
}
```

(Os `<canvas class="seq-wave">` já hidratados por `hydrateWaves` continuam como waveform dos blocos; nenhuma barra de gradiente fake entra.)

- [ ] **Step 7: Verificar**

`pnpm vitest run` inteiro + reload + screenshot `png/tarefa-6-montar-faixa.png`. Esperado: régua com passos nice, blocos proporcionais com waveform estilizada, playhead âmbar com chip de tempo que anda no play.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/app/assembly/editor/sequencia.js apps/cli/src/app/assembly/page.css apps/cli/src/app/assembly/sequencia.test.ts
git commit -m "feat(ui): faixa do editor vira timeline com régua e playhead"
```

---

### Task 7: Marcar — polimento na linguagem nova

**Files:**
- Modify: `apps/cli/src/mark-web/page.html` (tokens, layout 40/60, readout, marcas, barra de atalhos)

**Interfaces:**
- Consumes: tokens canônicos. Nenhum JS muda (ids/handlers intactos).

- [ ] **Step 1: Tokens + layout**

Troque o `:root` pelo canônico. No grid principal, vídeo 40% / coluna direita 60%:

```css
.stage { display: grid; grid-template-columns: 2fr 3fr; gap: 20px; align-items: start; }
.readout .big { font-family: var(--mono); font-size: 30px; font-variant-numeric: tabular-nums; }
.readout .lbl { font: 600 10.5px var(--sans-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
#marks li { font-family: var(--mono); font-size: 13px; }
#marks li.current { color: var(--accent); }
.shortcuts { background: var(--bg-1); border-top: 1px solid var(--line); }
kbd { font-family: var(--mono); background: var(--bg-2); border-color: var(--line-strong); }
```

Ajuste os seletores aos nomes reais do arquivo (o layout atual é vídeo à esquerda + `.right` à direita; mantenha ids `#video`, `#zoom`, `#overview`, `#marks`, `.readout`).

- [ ] **Step 2: Verificar**

Restart do serve.ts (mark lê no boot) + screenshot `png/tarefa-7-marcar.png`. Esperado: dark quente, vídeo menor que a onda, cursor display grande em mono, marcas em mono com a corrente em âmbar.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/mark-web/page.html
git commit -m "feat(ui): marcar na linguagem sala de corte com onda como hero"
```

---

### Task 8: Prova visual final + documentação

**Files:**
- Create: `docs/redesign-telas/depois/` (prints pós-redesign)
- Modify: `docs/redesign-telas/README.md`

- [x] **Step 1: Suíte completa**

```bash
pnpm vitest run && pnpm typecheck
```

- [x] **Step 2: Capturar o depois**

Com o harness no ar, capture as três telas (review do limpar, prévia da triagem, montar, montar rolada, marcar) em `docs/redesign-telas/depois/` com os mesmos nomes de `telas/`.

- [x] **Step 3: Atualizar README**

Na seção de prints do `docs/redesign-telas/README.md`, marque os existentes como "antes" e referencie `depois/` como "depois", com uma linha por tela do que mudou.

- [x] **Step 4: Commit**

```bash
git add docs/redesign-telas
git commit -m "docs: prova visual do redesign das telas"
```
