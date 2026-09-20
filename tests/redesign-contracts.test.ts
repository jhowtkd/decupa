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
});

it("nenhum atalho de simulação nas superfícies servidas", async () => {
  const files = [HTML, PAGEJS, CSS, RAIL, CONTEXTO, TEXTO, SEQ,
    "../apps/cli/src/app/page.html",
    "../apps/cli/src/app/provider-setup.html",
    "../apps/cli/src/mark-web/page.html"];
  for (const file of files) {
    expect(await read(file)).not.toContain("Simular reprodu");
  }
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
