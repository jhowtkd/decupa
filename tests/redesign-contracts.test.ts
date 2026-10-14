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
  for (const id of ["topbar", "stages", "monitor", "rail", "center", "stage", "texto", "contexto", "faixa", "status", "previewPlayer", "closeMonitor", "dropzone", "filePicker"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const js = (await Promise.all([PAGEJS, RAIL, CONTEXTO, TEXTO, SEQ].map(read))).join("\n");
  for (const id of ["briefingDialog", "delivery", "sourceCounts", "inspectorState", "deliveryChecklist", "versionHistory", "opLine", "openBriefing"]) {
    expect(js).toContain(id);
  }
  expect(js).toContain('materiais: "rail"');
  expect(js).toContain('entrega: "delivery"');
});

it("aprovação no front pede confirmação quando a prévia não foi vista inteira", async () => {
  const contexto = await read(CONTEXTO);
  expect(contexto).toContain("watchedState(project, state.get(\"watched\"))");
  expect(contexto).toContain("window.confirm(");
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

it("monitor estreito tem abrir/fechar + reduced-motion", async () => {
  const pagejs = await read(PAGEJS);
  const css = await read(CSS);
  expect(pagejs).toContain("matchMedia");
  expect(css).toContain(".only-narrow");
  expect(css).toContain("prefers-reduced-motion");
});

it("nenhuma concatenação presa dentro de literal de aspas simples", async () => {
  // '<p>x: " + expr + "</p>' renderiza o código em vez do valor.
  for (const file of [PAGEJS, RAIL, CONTEXTO, TEXTO, SEQ]) {
    const src = await read(file);
    expect(src.match(/'[^'\n]*" \+ [^'\n]*\+ "[^'\n]*'/)?.[0], file).toBeUndefined();
  }
});

it("palavra tocando no texto tem destaque no CSS", async () => {
  expect(await read(TEXTO)).toContain('btn.classList.toggle("ativa"');
  expect(await read(CSS)).toMatch(/\.word\.ativa\s*\{/);
});

it("etapa ativa: o aria-current que o JS grava é o que o CSS destaca", async () => {
  const pagejs = await read(PAGEJS);
  const css = await read(CSS);
  const html = await read(HTML);
  const value = pagejs.match(/setAttribute\("aria-current", "([^"]+)"\)/)?.[1];
  expect(value).toBeTruthy();
  expect(css).toContain(`#stages [aria-current="${value}"]`);
  expect(html).toContain(`data-stage="materiais" aria-current="${value}"`);
});

it("entrega atual travada: o cadeado fica visível e o nome diz que está travada", async () => {
  const css = await read(CSS);
  const js = await read(PAGEJS);
  expect(css).toContain('#stages [aria-current="page"].is-locked .step-mark { display: inline-flex; width: auto; height: auto; border-radius: 0; background: none; }');
  expect(css).toContain('#stages [aria-current="page"].is-locked .step-mark > svg { display: inline; }');
  expect(js).toContain('className = "sr"');
  expect(js).toContain('textContent = " travada"');
});
