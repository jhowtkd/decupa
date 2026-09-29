import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountSequencia } from "./sequencia.js";
import { installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function shell() {
  return installDom('<section id="faixa"></section><span id="undoSlot"></span>');
}

it("Desfazer mostra o passo do topo e Cmd+Z não chama com a pilha quebrada", () => {
  const document = shell();
  const state = createState({});
  const calls: string[] = [];
  const api = {
    call: vi.fn(async (path: string) => {
      calls.push(path);
      return { res: { ok: true }, body: {} };
    }),
  };
  const player = { seek: vi.fn(), el: () => null };
  const base = {
    revision: 3,
    undo: { head: 3, steps: [{ revision: 1, label: "Tirar trecho" }] },
    scenes: [],
    captions: [],
    corrections: [],
    analyses: [],
    assembly: { fps: { num: 25, den: 1 }, sources: [], tracks: [] },
  };
  state.set("undoRevision", 1);
  state.set("project", base);
  mountSequencia({ state, api, player });
  const undo = document.getElementById("undo")!;
  const what = undo.querySelector(".undo-what");
  const before = {
    title: undo.title,
    aria: undo.getAttribute("aria-label"),
    what: what?.textContent ?? "",
    disabled: undo.disabled,
  };
  state.set("project", { ...base, revision: 4, undo: { head: 2, steps: [{ revision: 1, label: "Tirar trecho" }] } });
  state.set("undoRevision", 1);
  document.dispatchEvent({ type: "keydown", key: "z", metaKey: true, target: document.body });
  expect({
    ...before,
    afterDisabled: undo.disabled,
    undos: calls.length,
  }).toEqual({
    title: "Desfazer: Tirar trecho",
    aria: "Desfazer: Tirar trecho",
    what: "Tirar trecho",
    disabled: false,
    afterDisabled: true,
    undos: 0,
  });
});

it("waveform da faixa vai por fetch e não por api.call", async () => {
  shell();
  const fetchMock = vi.mocked(fetch);
  const state = createState({});
  const api = {
    call: vi.fn(async (_path: string) => ({ res: { ok: true, status: 200 }, body: { peaks: [] } })),
  };
  const p = {
    revision: 1,
    scenes: [{
      id: "s1",
      objective: "Cena",
      takes: [{ id: "t1", sourceId: "a", start: 0, end: 1, removed: [], protected: [] }],
      support: [],
      gaps: [],
    }],
    captions: [],
    corrections: [],
    analyses: [{ sourceId: "a", words: [], visual: [] }],
    assembly: {
      fps: { num: 25, den: 1 },
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }],
      tracks: [],
    },
  };
  state.set("project", p);
  mountSequencia({ state, api, player: { seek: vi.fn(), el: () => null } });
  const viaApi = api.call.mock.calls.some((call) => String(call[0]).includes("waveform"));
  const viaFetch = fetchMock.mock.calls.some((call) => String(call[0]).includes("/project/waveform/"));
  expect({ viaApi, viaFetch }).toEqual({ viaApi: false, viaFetch: true });
  await Promise.resolve();
  await Promise.resolve();
});
