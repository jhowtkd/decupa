import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const HTML = "../apps/cli/src/app/assembly/page.html";
const CSS = "../apps/cli/src/app/assembly/page.css";
const PAGEJS = "../apps/cli/src/app/assembly/page.js";
const RAIL = "../apps/cli/src/app/assembly/editor/rail.js";
const TEXTO = "../apps/cli/src/app/assembly/editor/texto.js";
const CONTEXTO = "../apps/cli/src/app/assembly/editor/contexto.js";
const SEQ = "../apps/cli/src/app/assembly/editor/sequencia.js";

async function read(p: string): Promise<string> {
  return readFile(new URL(p, import.meta.url), "utf8");
}

it("casca: topo + três cartões, sem coluna de ferramentas nem navegação duplicada", async () => {
  const html = await read(HTML);
  for (const id of ["topbar", "stages", "rail", "center", "textoHead", "textoMeta", "undoSlot", "texto",
    "monitor", "stage", "activity", "faixa", "contexto", "monitorBriefing", "versionPill",
    "monitorToggle", "closeMonitor", "status", "primaryAction", "newProject"]) {
    expect(html, id).toContain(`id="${id}"`);
  }
  for (const gone of ['id="tools"', 'id="reviewAction"', 'id="deliveryAction"', 'id="mediaTool"', 'id="inspectTool"']) {
    expect(html).not.toContain(gone);
  }
  expect(html.match(/class="card"/g)).toHaveLength(3);
});

it("casca: tokens dos painéis e grade topo/rail/centro/monitor", async () => {
  const css = await read(CSS);
  for (const token of ["--ground: #0B0C0E", "--card: #151619", "--card-2: #1C1E22",
    "--radius-card: 16px", "--radius-pill: 999px", "--gap: 12px"]) {
    expect(css).toContain(token);
  }
  expect(css).toMatch(/grid-template:\s*"topbar topbar topbar" 48px\s*"rail center monitor" minmax\(0, 1fr\)/);
  expect(css).not.toContain("#tools");
  const narrow = css.slice(css.indexOf("@media (max-width: 700px)"));
  expect(narrow).toContain(".topbar-project, .topbar-actions { flex: 1 1 100%; }");
});

it("casca: etapa não remonta a bancada; entrega mora no cartão central", async () => {
  const js = await read(PAGEJS);
  expect(js).toContain("function showMonitor(");
  expect(js).not.toContain("inspectTool");
  expect(js).not.toContain('data-tool="texto"');
  const contexto = await read(CONTEXTO);
  expect(contexto).toContain('document.getElementById("center").appendChild(delivery)');
  expect(contexto).not.toContain("closeInspector");
  expect(await read(TEXTO)).toContain("const scroller = texto;");
  expect(await read(RAIL)).toContain('id="openBriefing"');
});

it("topo: etapas pintadas pelo estado do projeto, versão em pílula", async () => {
  const js = await read(PAGEJS);
  expect(js).toContain('from "/editor/topbar.js"');
  expect(js).toContain("function paintStages(");
  expect(js).toContain('getElementById("versionPill")');
  expect(js).not.toContain('"revisão " + p.revision');
});

it("rail: lista compacta com menu por material, papel 'Fala + apoio' e sem jargão", async () => {
  const rail = await read(RAIL);
  expect(rail).toContain('["speech", "support", "both"]');
  expect(rail).toContain('className = "source-menu"');
  expect(rail).toContain('sceneNav.id = "sceneNav"');
  expect(rail).toContain('templateSlot.id = "templateSlot"');
  expect(rail).toContain('id="briefingForm"');
  expect(rail).not.toContain('"Relink"');
  expect(rail).not.toContain('chip("excluída")');
  const templates = await read("../apps/cli/src/app/assembly/editor/templates.js");
  expect(templates).toContain('getElementById("templateSlot")');
});

it("texto: prosa em serifa, sem glifos nos controles de cena, menus por classe", async () => {
  const texto = await read(TEXTO);
  for (const glyph of ["↥", "↧", "✕", "✂", "🎬"]) expect(texto).not.toContain(glyph);
  expect(texto).toContain("data-scene-menu");
  expect(texto).toContain("data-include-zone");
  expect(texto).not.toContain("menu.style.cssText");
  const css = await read(CSS);
  expect(css).toMatch(/\.prose\s*\{[^}]*var\(--serif\)/);
  expect(css).toContain(".float-menu");
});

it("prévia: cartão de revisão com anel de progresso e aprovar travado com cadeado", async () => {
  const contexto = await read(CONTEXTO);
  expect(contexto).toContain('from "./progress.js"');
  expect(contexto).toContain('id="watchRing"');
  expect(contexto).toContain('classList.toggle("is-locked"');
  expect(contexto).toContain("watchedState(project, watched).canApprove");
  expect(contexto).not.toContain("▰");
  expect(contexto).not.toContain('className = "stage-footer"');
});

it("contexto: pendências em lista, cena sem botões duplicados, pedido à IA com aviso de custo", async () => {
  const contexto = await read(CONTEXTO);
  expect(contexto).toContain("pendingItems(project)");
  for (const gone of ['id="sceneBefore"', 'id="sceneAfter"', 'id="sceneDelete"', "B-roll", "aprovada ✓"]) {
    expect(contexto).not.toContain(gone);
  }
  expect(contexto).toContain("Envia texto e quadros ao provedor configurado · pode haver cobrança");
  expect(contexto).toContain('aria-label="Aplicar ajuste com IA"');
});

it("sequência: rótulo em português, desfazer no cabeçalho do texto, sem altura inline", async () => {
  const seq = await read(SEQ);
  expect(seq).toContain('label.textContent = "Sequência"');
  expect(seq).toContain('getElementById("undoSlot")');
  expect(seq).not.toContain("⎌");
  expect(seq).not.toContain("min-height:154px");
  expect(seq).toContain("clock(t)");
  // Desfazer em voo: clique e atalho passam pela mesma guarda.
  expect(seq).toContain("const undoEdit = singleFlight(");
  expect(seq).toContain('"aria-busy"');
});

it("estados: vazio com briefing no monitor, preparação com etapas e custo visível", async () => {
  const texto = await read(TEXTO);
  expect(texto).toContain("Seu próximo vídeo começa aqui");
  const rail = await read(RAIL);
  expect(rail).toContain("function placeBriefing(");
  expect(rail).toContain('className = "step-state"');
  expect(rail).toContain("Usa o provedor configurado · pode haver cobrança");
  expect(rail).not.toContain('(done ? "✓ " : "")');
  expect(await read(PAGEJS)).toContain('classList.toggle("is-empty"');
  const css = await read(CSS);
  expect(css).toContain("body.is-empty");
});

it("entrega: sem emoji, arquivos por deliveryFormats, status sem ' · ' solto", async () => {
  const contexto = await read(CONTEXTO);
  expect(contexto).toContain("deliveryFormats(project, verificacao)");
  expect(contexto).toContain("verifyView(project, verificacao)");
  expect(contexto).toContain('id="verifyCard"');
  expect(contexto).not.toContain('+" · O .drp depende');
  for (const glyph of ["🔒", "🔓", '"✓ "', '"○ "']) expect(contexto).not.toContain(glyph);
  // Confirmar a conferência não muda o projeto: o cartão redesenha pela verificação.
  expect(contexto).toContain('state.subscribe("verificacao"');
  // Textos do artboard: seção de arquivos e origem do formato fora da linha mono.
  expect(contexto).toContain(">Montagem preparada para o DaVinci</h2>");
  expect(contexto).toContain('id="formatOrigin"');
  expect(contexto).toContain("formatOrigin(project.assembly)");
});

it("limpar: casca de três cartões, maiúscula inicial e faixa da fonte pura", async () => {
  const html = await read("../apps/cli/src/app/page.html");
  for (const id of ["topbar", "steps", "side", "center", "monitor-card", "monitor", "strip", "triage", "player"]) {
    expect(html, id).toContain(`id="${id}"`);
  }
  for (const label of [">Cancelar<", ">Sugerir cortes<", "Exportar<svg", ">Aplicar<", ">Descartar<"]) {
    expect(html).toContain(label);
  }
  for (const old of [">cancelar<", ">sugerir cortes<", ">aplicar<", ">descartar<", "⚠"]) expect(html).not.toContain(old);
  const src = html.slice(html.indexOf("// <strip-model>"), html.indexOf("// </strip-model>"));
  const stripModel = runInNewContext(src + "; stripModel");
  const kept = new Map([["u1", true], ["u2", false], ["u3", true]]);
  const segs = stripModel([
    { id: "u1", start: 0, end: 2, flags: [] },
    { id: "u2", start: 2, end: 5, flags: [] },
    { id: "u3", start: 5, end: 10, flags: [{ message: "olhou pro monitor" }] },
  ], kept, 10);
  expect(segs).toEqual([
    { id: "u1", left: 0, width: 20, kept: true, flagged: false },
    { id: "u2", left: 20, width: 30, kept: false, flagged: false },
    { id: "u3", left: 50, width: 50, kept: true, flagged: true },
  ]);
  expect(stripModel([], kept, 0)).toEqual([]);
});

it("marcar: cartões, rótulo honesto do apagar, cores do tema e marca mais próxima pura", async () => {
  const html = await read("../apps/cli/src/mark-web/page.html");
  expect(html).toContain(">Apagar a mais próxima<");
  expect(html).not.toContain(">Desfazer<");
  for (const old of ["#f2c230", "#63be97", "#e4e9e5", "#5d7480", "#232c31"]) expect(html.toLowerCase()).not.toContain(old);
  expect(html).toContain('class="card');
  const src = html.slice(html.indexOf("// <nearest>"), html.indexOf("// </nearest>"));
  const nearestIndex = runInNewContext(src + "; nearestIndex");
  expect(nearestIndex([420, 1180, 5020], 5280)).toBe(2);
  expect(nearestIndex([420, 1180], 800)).toBe(0);
  expect(nearestIndex([], 100)).toBe(-1);
});

it("varredura: nenhuma superfície servida usa emoji ou glifo como ícone", async () => {
  const files = [HTML, CSS, PAGEJS, RAIL, TEXTO, CONTEXTO, SEQ,
    "../apps/cli/src/app/assembly/editor/templates.js",
    "../apps/cli/src/app/page.html",
    "../apps/cli/src/mark-web/page.html"];
  const banned = ["▰", "▱", "☷", "⎌", "🎬", "✂", "🔒", "🔓", "↥", "↧", "⚠", "▤", "✓"];
  for (const file of files) {
    const src = await read(file);
    for (const glyph of banned) expect(src.includes(glyph), `${file} contém ${glyph}`).toBe(false);
  }
});
