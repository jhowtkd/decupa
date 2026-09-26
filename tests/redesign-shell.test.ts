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

it("rail.js mantém briefing editável e montagem direta, sem confirmação de custo", async () => {
  const js = await readFile(new URL("../apps/cli/src/app/assembly/editor/rail.js", import.meta.url), "utf8");
  for (const s of ['id = "briefingDialog"', "showModal"]) {
    expect(js).toContain(s);
  }
  expect(js).not.toContain("prepDialog");
  // Ação principal decide entre navegar (revisar/entregar, grátis) e
  // montar/preparar (POST pago) — #62: revisar nunca re-cobra.
  expect(js).toContain('document.getElementById("prepare").onclick = prepareClick');
  expect(js).toContain('document.getElementById("resume").onclick = prepareMontage');
  expect(js).toContain("decupa:set-stage");
  expect(js).toContain("modelOptIn: true, visualOptIn: true");
});

it("entrega mora no inspetor, não no rail", async () => {
  const rail = await readFile(new URL("../apps/cli/src/app/assembly/editor/rail.js", import.meta.url), "utf8");
  const contexto = await readFile(new URL("../apps/cli/src/app/assembly/editor/contexto.js", import.meta.url), "utf8");
  expect(rail).not.toContain("renderDelivery");
  expect(contexto).toContain('id = "delivery"');
  expect(contexto).toContain("versionHistory");
});
