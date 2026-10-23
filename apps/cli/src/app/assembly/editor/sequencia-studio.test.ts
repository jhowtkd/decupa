// A faixa do studio redesenha a waveform quando a largura aparece; a legacy não observa nada.
import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountSequencia } from "./sequencia.js";
import { installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class FakeObserver {
  static todos: FakeObserver[] = [];
  observados: unknown[] = [];
  constructor(readonly aviso: (entries: Array<{ contentRect: { width: number } }>) => void) {
    FakeObserver.todos.push(this);
  }
  observe(el: unknown) { this.observados.push(el); }
  disconnect() {}
  largura(width: number) { this.aviso([{ contentRect: { width } }]); }
}

function projeto() {
  return {
    revision: 1,
    scenes: [{
      id: "s1",
      objective: "Cena",
      takes: [{ id: "t1", sourceId: "a", start: 0, end: 2, removed: [], protected: [] }],
      support: [],
      gaps: [],
    }],
    captions: [],
    corrections: [],
    analyses: [{ sourceId: "a", words: [], visual: [] }],
    assembly: { fps: { num: 25, den: 1 }, sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false, hasAudio: true }], tracks: [] },
  };
}

function monta(ui?: "studio" | "legacy", comPeaks = true) {
  FakeObserver.todos = [];
  const document = installDom('<section id="faixa"></section><span id="undoSlot"></span>');
  vi.stubGlobal("ResizeObserver", FakeObserver);
  const peaks = { sampleRate: 8000, count: 64 * 320, peaks: Array.from({ length: 64 }, () => ({ min: -100, max: 100 })) };
  const fetchMock = vi.fn(async () => (comPeaks
    ? { ok: true, status: 200, json: async () => peaks }
    : { ok: true, status: 204, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  const state = createState({});
  state.set("project", projeto());
  const api = { call: vi.fn(async () => ({ res: { ok: true }, body: {} })) };
  const player = { seek: vi.fn(), el: () => null };
  if (ui === undefined) mountSequencia({ state, api, player });
  else mountSequencia({ state, api, player, ui });
  return { document, fetchMock, api };
}

const cheio = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("sem ui (ou legacy) a faixa não cria ResizeObserver; com studio cria um, sobre #faixa", () => {
  monta();
  expect(FakeObserver.todos).toHaveLength(0);
  monta("legacy");
  expect(FakeObserver.todos).toHaveLength(0);
  const { document } = monta("studio");
  expect(FakeObserver.todos).toHaveLength(1);
  expect(FakeObserver.todos[0]!.observados).toEqual([document.getElementById("faixa")]);
});

/** Canvas do DOM falso com contexto espião; `largura` faz o canvas "aparecer" (clientWidth/Height > 0). */
function instrumenta(document: ReturnType<typeof installDom>) {
  const canvas = document.querySelector("canvas.seq-wave")! as unknown as {
    clientWidth: number; clientHeight: number; getContext: (tipo: string) => unknown;
  };
  const fillRect = vi.fn();
  canvas.getContext = () => ({ clearRect: vi.fn(), fillRect });
  const largura = (w: number) => { canvas.clientWidth = w; canvas.clientHeight = w > 0 ? 40 : 0; };
  return { canvas, fillRect, largura };
}

it("studio: largura 0→N redesenha só com o cache, sem fetch novo; 0 e a mesma largura não redesenham", async () => {
  const { document, fetchMock, api } = monta("studio");
  await cheio();
  const { canvas, fillRect, largura } = instrumenta(document);
  expect(canvas).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const observer = FakeObserver.todos[0]!;

  largura(0);
  observer.largura(0);
  await cheio();
  expect(fillRect).not.toHaveBeenCalled();

  largura(640);
  observer.largura(640);
  await cheio();
  expect(fillRect).toHaveBeenCalled();

  fillRect.mockClear();
  observer.largura(640);
  await cheio();
  expect(fillRect).not.toHaveBeenCalled();

  observer.largura(0);
  await cheio();
  expect(fillRect).not.toHaveBeenCalled();
  largura(320);
  observer.largura(320);
  await cheio();
  expect(fillRect).toHaveBeenCalled();

  await cheio();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(api.call).not.toHaveBeenCalled();
});

it("studio: fonte sem waveform (204) fica sem desenho e a largura nova não refaz o pedido", async () => {
  const { document, fetchMock } = monta("studio", false);
  await cheio();
  const { fillRect, largura } = instrumenta(document);
  largura(500);
  FakeObserver.todos[0]!.largura(500);
  await cheio();
  expect(fillRect).not.toHaveBeenCalled();
  await cheio();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
