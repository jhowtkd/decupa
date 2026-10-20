import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountTexto } from "./texto.js";
import { El, installDom } from "./fake-dom.test-helper.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const words = Array.from({ length: 30 }, (_, i) => ({ id: `w${i + 1}`, text: `palavra${i + 1}`, start: i, end: i + 0.5 }));
  return {
    id: "p-playhead", revision: 1, previewRevision: null, preparation: null, corrections: [],
    assembly: {
      name: "playhead", fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }], tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words, visual: [], speech: [] }],
    scenes: [0, 1, 2].map((i) => ({
      id: `s${i + 1}`, objective: `Cena ${i + 1}`, rationale: "",
      takes: [{ id: `t${i + 1}`, sourceId: "a", start: i * 10, end: i * 10 + 9.5, removed: [], protected: [] }],
      support: [], gaps: [],
    })),
  };
}

it("move ativa do playhead duas vezes e limpa a palavra anterior através de desmontagem e remontagem", () => {
  const document = installDom('<section id="texto"></section><div id="dropzone" hidden></div>');
  const win = (globalThis as unknown as { window: {
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    dispatchEvent: (event: { type: string }) => void;
  } }).window;
  win.addEventListener = () => {}; win.removeEventListener = () => {}; win.dispatchEvent = () => {};
  const state = createState({ selection: new Set<string>(), playhead: null });
  const api = { call: vi.fn(async () => ({ res: { ok: true, status: 200 }, body: {} })), notifyError: vi.fn() };
  const player = { seek: vi.fn(), playOriginal: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player });
  state.set("project", fixture());
  const root = document.getElementById("texto")!;
  root.clientHeight = 100;
  El.prototype.getBoundingClientRect = function () {
    if (this.id === "texto") return { left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 };
    if (this.dataset.sceneSection) {
      const top = (Number(this.dataset.sceneSection.slice(1)) - 1) * 300 - root.scrollTop;
      return { left: 0, top, right: 500, bottom: top + 240, width: 500, height: 240 };
    }
    return { left: 0, top: 0, right: 500, bottom: 20, width: 500, height: 20 };
  };
  const s1 = document.querySelector('[data-scene-section="s1"]')!;
  const first = s1.querySelector('[data-word-id="w1"]')!;
  state.set("playhead", 0.2);
  expect(first.classList.contains("ativa")).toBe(true);
  state.set("playhead", 1.2);
  const second = s1.querySelector('[data-word-id="w2"]')!;
  expect(second.classList.contains("ativa")).toBe(true);
  expect(first.classList.contains("ativa")).toBe(false);
  // Retire s1 do DOM e avance para uma palavra dela; a troca deve limpar a
  // referência antiga mesmo enquanto sua cena está desmontada.
  root.scrollTop = 600;
  root.dispatchEvent({ type: "scroll" });
  expect(s1.dataset.sceneMounted).toBe("false");
  state.set("playhead", 2.2);
  expect(second.classList.contains("ativa")).toBe(false);
  root.scrollTop = 0;
  root.dispatchEvent({ type: "scroll" });
  expect(s1.dataset.sceneMounted).toBe("true");
  const remounted = s1.querySelector('[data-word-id="w3"]')!;
  expect(remounted.classList.contains("ativa")).toBe(true);
  expect(s1.querySelectorAll(".word.ativa")).toHaveLength(1);
});
