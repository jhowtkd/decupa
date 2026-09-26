import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const HTML = "../apps/cli/src/app/assembly/page.html";
const CSS = "../apps/cli/src/app/assembly/page.css";
const PAGEJS = "../apps/cli/src/app/assembly/page.js";
const RAIL = "../apps/cli/src/app/assembly/editor/rail.js";
const TEXTO = "../apps/cli/src/app/assembly/editor/texto.js";
const CONTEXTO = "../apps/cli/src/app/assembly/editor/contexto.js";
const SEQ = "../apps/cli/src/app/assembly/editor/sequencia.js";
// A T8 passa a afirmar este arquivo; o binding fica desde a T2 e o lint não aceita constante solta.
void SEQ;

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
