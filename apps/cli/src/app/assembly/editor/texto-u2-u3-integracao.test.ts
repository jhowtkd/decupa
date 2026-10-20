import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountTexto } from "./texto.js";
import { El, installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function words(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, text: `palavra${i + 1}`, start: i, end: i + 0.5 }));
}

function project(count = 20, sceneCount = 20) {
  const perScene = count / sceneCount;
  return {
    id: "p-u2-u3", revision: 1, previewRevision: null, preparation: null, corrections: [] as unknown[],
    assembly: {
      name: "Integração U2 U3", fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }], tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words: words(count), visual: [], speech: [] }],
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      id: `s${i + 1}`, objective: `Cena ${i + 1}`, rationale: "",
      takes: [{ id: `t${i + 1}`, sourceId: "a", start: i * perScene, end: i * perScene + perScene - 0.5, removed: [], protected: [] }],
      support: [], gaps: [],
    })),
  };
}

function mount(p: ReturnType<typeof project>) {
  const document = installDom('<section id="texto"></section><div id="dropzone" hidden></div>');
  const win = (globalThis as unknown as { window: {
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    dispatchEvent: (event: { type: string }) => void;
  } }).window;
  const windowListeners = new Map<string, Set<() => void>>();
  win.addEventListener = (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type)!.add(listener);
  };
  win.removeEventListener = (type, listener) => windowListeners.get(type)?.delete(listener);
  win.dispatchEvent = (event) => { for (const listener of windowListeners.get(event.type) || []) listener(); };
  const state = createState({ selection: new Set<string>(), playhead: null });
  const api = { call: vi.fn(async () => ({ res: { ok: true, status: 200 }, body: {} })), notifyError: vi.fn() };
  const player = { seek: vi.fn(), playOriginal: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player });
  state.set("project", p);
  return { state, document };
}

function toggleDetails(root: El, details: El) {
  details.querySelector("summary")!.click();
  details.open = !details.open;
  root.dispatchEvent({ type: "toggle", target: details, bubbles: false });
}

function virtualGeometry(document: FakeDocument) {
  const originalRect = El.prototype.getBoundingClientRect;
  const originalScrollIntoView = (El.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
  const root = document.getElementById("texto")!;
  root.clientHeight = 200;
  root.scrollTop = 0;
  El.prototype.getBoundingClientRect = function () {
    if (this.id === "texto") return { left: 0, top: 0, right: 500, bottom: root.clientHeight, width: 500, height: root.clientHeight };
    const sceneId = this.dataset.sceneSection;
    if (sceneId) {
      const index = Number(sceneId.slice(1)) - 1;
      const top = index * 300 - root.scrollTop;
      return { left: 0, top, right: 500, bottom: top + 240, width: 500, height: 240 };
    }
    return originalRect.call(this);
  };
  (El.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: El) {
    if (this.dataset.sceneSection) {
      root.scrollTop = (Number(this.dataset.sceneSection.slice(1)) - 1) * 300;
      root.dispatchEvent({ type: "scroll" });
    }
  };
  return () => {
    El.prototype.getBoundingClientRect = originalRect;
    if (originalScrollIntoView) (El.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = originalScrollIntoView;
    else delete (El.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
  };
}

function tabStops(block: El) {
  return block.querySelectorAll('button.word[tabindex="0"]');
}

it("dá exatamente um ponto de Tab a cada bloco com palavras nas cenas montadas após o scroll", () => {
  const { document } = mount(project());
  const restore = virtualGeometry(document);
  try {
    const root = document.getElementById("texto")!;
    root.scrollTop = 3_000;
    root.dispatchEvent({ type: "scroll" });
    const mounted = document.querySelectorAll('section[data-scene-mounted="true"]');
    expect(mounted.some((section) => section.dataset.sceneSection === "s11")).toBe(true);
    const blocks = mounted.flatMap((section) => section.querySelectorAll(".prose"))
      .filter((block) => block.querySelectorAll("button.word").length > 0);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(tabStops(block)).toHaveLength(1);
  } finally {
    restore();
  }
});

it("lembra a palavra de Tab de um bloco depois de desmontar e remontar sua cena", () => {
  const { document } = mount(project(40, 20));
  const restore = virtualGeometry(document);
  try {
    const root = document.getElementById("texto")!;
    const first = document.querySelector('[data-scene-section="s1"]')!;
    const remembered = first.querySelector('[data-word-id="w2"]')!;
    remembered.focus();
    remembered.dispatchEvent({ type: "focusin" });
    expect(remembered.getAttribute("tabindex")).toBe("0");

    document.querySelector('[data-scene-section="s2"] [data-word-id="w3"]')!.focus();
    root.scrollTop = 3_000;
    root.dispatchEvent({ type: "scroll" });
    expect(first.dataset.sceneMounted).toBe("false");
    root.scrollTop = 0;
    root.dispatchEvent({ type: "scroll" });

    const remounted = first.querySelector('[data-word-id="w2"]')!;
    expect(first.dataset.sceneMounted).toBe("true");
    expect(remounted.getAttribute("tabindex")).toBe("0");
    expect(tabStops(first.querySelector(".prose")!)).toHaveLength(1);
  } finally {
    restore();
  }
});

it("pinta o ponto de Tab ao abrir omitidos em cena montada depois do render inicial", () => {
  const { document } = mount(project());
  const restore = virtualGeometry(document);
  try {
    const root = document.getElementById("texto")!;
    root.scrollTop = 3_000;
    root.dispatchEvent({ type: "scroll" });
    const section = document.querySelector('[data-scene-section="s11"]')!;
    const details = section.querySelector('details[data-omitted-source="a"]')!;
    toggleDetails(root, details);
    const omittedBlock = details.querySelector(".prose")!;
    expect(omittedBlock.querySelectorAll("button.word").length).toBeGreaterThan(0);
    expect(tabStops(omittedBlock)).toHaveLength(1);
  } finally {
    restore();
  }
});

it("preserva foco por posição editorial quando snapshot alinhado troca o ID em cena preguiçosa", () => {
  const { state, document } = mount(project());
  const restore = virtualGeometry(document);
  try {
    const root = document.getElementById("texto")!;
    root.scrollTop = 3_000;
    root.dispatchEvent({ type: "scroll" });
    const focused = document.querySelector('[data-scene="s11"][data-word-id="w11"]')!;
    focused.focus();

    const aligned = project();
    aligned.revision = 2;
    aligned.corrections = [{ sourceId: "a", status: "aligned", start: 10, end: 10.5,
      words: [{ id: "a:sha:c:c1:w000011", text: "palavra alinhada", start: 10, end: 10.5 }] }];
    state.set("project", aligned);

    expect(document.activeElement?.dataset.scene).toBe("s11");
    expect(document.activeElement?.dataset.wordId).toBe("a:sha:c:c1:w000011");
  } finally {
    restore();
  }
});

it("estende com Shift+seta a seleção entre palavras de cenas vizinhas montadas", () => {
  const { state, document } = mount(project());
  const restore = virtualGeometry(document);
  try {
    const first = document.querySelector('[data-scene="s1"][data-word-id="w1"]')!;
    first.focus();
    first.dispatchEvent({ type: "keydown", key: "ArrowRight", shiftKey: true });

    expect(state.get("selection")).toEqual(new Set(["s1\0t1\0w1", "s2\0t2\0w2"]));
    expect(document.activeElement?.dataset.scene).toBe("s2");
    expect(document.activeElement?.dataset.wordId).toBe("w2");
  } finally {
    restore();
  }
});
