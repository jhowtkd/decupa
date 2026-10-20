import { afterEach, expect, it, vi } from "vitest";
import { deliveryFormats, resolveView } from "./rail.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("selects MP4 and package on installations without Resolve", () => {
  const view = resolveView(null, true, { resolve: false, primary: "package" });
  expect(view.buttonLabel).toBe("Preparar MP4 + pacote");
  expect(view.disabled).toBe(false);
  expect(resolveView(null, false, { resolve: false }).disabled).toBe(true);
});
it("keeps the bridge action on an installation with Resolve", () => {
  expect(resolveView(null, true, { resolve: true }).buttonLabel).toBe("Abrir no DaVinci");
});
it("offers MP4 and the complete package as the first portable downloads", () => {
  const formats = deliveryFormats({ revision: 3, finalApprovedRevision: 3 }, { revision: 3, package: true }, null, { resolve: false });
  expect(formats.slice(0, 2).map((f: { id: string }) => f.id)).toEqual(["mp4", "package"]);
});

it("keeps package preparation available for an older export that has no package", async () => {
  const { installDom } = await import("./fake-dom.test-helper.ts");
  const { createState } = await import("./state.js");
  const { mountContexto } = await import("./contexto.js");
  const { fixtureAssembly } = await import("../fixture.ts");
  const document = installDom('<section id="contexto"></section><div id="center"></div>');
  const state = createState({});
  mountContexto({ state, api: { call: async () => ({ res: { ok: true }, body: {} }), notifyError() {} }, player: { previewBusy: () => false, seek() {} } });
  state.set("project", { id: "p", revision: 1, previewRevision: 1, finalApprovedRevision: 1, assembly: fixtureAssembly(), corrections: [], scenes: [], analyses: [] });
  state.set("verificacao", { revision: 1, status: "confirmada" });
  expect(document.getElementById("exportTimeline")!.hidden).toBe(false);
  expect(document.getElementById("exportTimeline")!.textContent).toBe("Preparar MP4 + pacote");
  expect(document.getElementById("resolveAutomatic")!.hidden).toBe(true);
  state.set("verificacao", { revision: 1, status: "pendente", package: true });
  expect(document.getElementById("exportTimeline")!.hidden).toBe(true);
});

it("team delivery lists MP4 and package first even when the server has Resolve", () => {
  const formats = deliveryFormats({ revision: 3, finalApprovedRevision: 3 }, { revision: 3, package: true }, null, { resolve: true, primary: "package" });
  expect(formats.slice(0, 2).map((f: { id: string }) => f.id)).toEqual(["mp4", "package"]);
});

it("labels the installed bridge as an explicit secondary action on the server", async () => {
  const { installDom } = await import("./fake-dom.test-helper.ts");
  const { createState } = await import("./state.js");
  const { mountContexto } = await import("./contexto.js");
  const { fixtureAssembly } = await import("../fixture.ts");
  const document = installDom('<section id="contexto"></section><div id="center"></div>');
  vi.stubGlobal("fetch", async () => ({ json: async () => ({ capabilities: { resolve: true, primary: "package" } }) }));
  const state = createState({});
  mountContexto({ state, api: { call: async () => ({ res: { ok: false }, body: { error: "falha da ponte" } }), notifyError() {} }, player: { previewBusy: () => false, seek() {} } });
  state.set("project", { id: "p", revision: 1, previewRevision: 1, finalApprovedRevision: 1, assembly: fixtureAssembly(), corrections: [], scenes: [], analyses: [] });
  await vi.waitFor(() => expect(document.getElementById("resolveAutomatic")!.hidden).toBe(false));
  expect(document.getElementById("exportTimeline")!.textContent).toBe("Preparar MP4 + pacote");
  expect(document.getElementById("export")!.textContent).toBe("Abrir no Resolve do servidor");
  document.getElementById("export")!.click();
  await vi.waitFor(() => expect(document.getElementById("exportStatus")!.textContent).toContain("falha da ponte"));
});
