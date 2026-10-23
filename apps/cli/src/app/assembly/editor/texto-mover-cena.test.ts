// "Mover para cima/baixo" do menu da cena: no studio envia a ordem inteira
// (reorder-scenes, como o arraste); na legacy segue o move-scene.
import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountTexto } from "./texto.js";
import { installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PALAVRAS = ["um", "dois", "tres", "quatro", "cinco", "seis"]
  .map((text, i) => ({ id: "w" + (i + 1), text, start: i * 0.5, end: i * 0.5 + 0.5 }));

function projeto() {
  return {
    id: "p", revision: 6, previewRevision: null, preparation: null, corrections: [],
    assembly: {
      name: "Montagem", fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }], tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words: PALAVRAS, visual: [], speech: [] }],
    scenes: ["s1", "s2", "s3"].map((id, i) => ({
      id, objective: "Cena " + id, rationale: "",
      takes: [{ id: "t" + id, sourceId: "a", start: i, end: i + 1, removed: [], protected: [] }],
      support: [], gaps: [],
    })),
  };
}

const HTML = '<main id="center"><div id="textoHead"><span class="spacer"></span><span id="undoSlot"></span></div>'
  + '<section id="texto"></section></main><div id="dropzone" hidden></div>';

function montar(ui: "studio" | "legacy") {
  const document = installDom(HTML);
  const state = createState({ selection: new Set<string>(), playhead: null, stage: "edicao" });
  const api = {
    call: vi.fn(async (..._args: unknown[]) => ({ res: { ok: true, status: 200 }, body: {} })),
    notifyError: vi.fn(),
  };
  const player = { seek: vi.fn(), playOriginal: vi.fn(), playMontage: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player, ui });
  state.set("project", projeto());
  return { document, api, state };
}

/** Só as cenas perto da tela estão montadas; selecionar a cena a monta. */
async function mover(document: FakeDocument, state: { set: (k: string, v: unknown) => void }, cena: string, acao: "up" | "down") {
  state.set("selectedScene", cena);
  document.querySelector(`[data-scene-menu="${cena}"]`)!.click();
  const item = document.querySelectorAll('[role="menuitem"]').find((btn) => btn.dataset.sceneAction === acao)!;
  item.click();
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

const corpos = (api: { call: { mock: { calls: unknown[][] } } }) =>
  api.call.mock.calls.map((c) => ({ path: c[0], body: JSON.parse(String((c[1] as { body: string }).body)) }));

it("studio: Mover para baixo envia reorder-scenes com a ordem inteira e a revisão da tela", async () => {
  const { document, api, state } = montar("studio");
  await mover(document, state, "s1", "down");
  expect(corpos(api)).toEqual([{ path: "project/edit", body: { baseRevision: 6, action: { type: "reorder-scenes", order: ["s2", "s1", "s3"] } } }]);
  expect((api.call.mock.calls[0]![1] as { label: string }).label).toBe("Movendo cena…");
});

it("studio: Mover para cima envia a ordem inteira com a cena uma posição antes", async () => {
  const { document, api, state } = montar("studio");
  await mover(document, state, "s3", "up");
  expect(corpos(api)).toEqual([{ path: "project/edit", body: { baseRevision: 6, action: { type: "reorder-scenes", order: ["s1", "s3", "s2"] } } }]);
});

it("studio: mover nos extremos fica desabilitado e não envia nada", async () => {
  const { document, api, state } = montar("studio");
  state.set("selectedScene", "s1");
  document.querySelector('[data-scene-menu="s1"]')!.click();
  const cima = document.querySelectorAll('[role="menuitem"]').find((btn) => btn.dataset.sceneAction === "up")!;
  expect(cima.disabled).toBe(true);
  await mover(document, state, "s3", "down");
  expect(api.call).not.toHaveBeenCalled();
});

it("legacy: Mover para baixo envia move-scene, não reorder-scenes", async () => {
  const { document, api, state } = montar("legacy");
  await mover(document, state, "s1", "down");
  expect(corpos(api)).toEqual([{ path: "project/edit", body: { baseRevision: 6, action: { type: "move-scene", sceneId: "s1", direction: "down" } } }]);
});
