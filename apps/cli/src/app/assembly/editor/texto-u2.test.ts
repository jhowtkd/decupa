import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { docSignature, mountTexto } from "./texto.js";
import { omittedWordCount, omittedWords } from "./montage.js";
import { El, installDom, type FakeDocument } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function words(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${i + 1}`,
    text: `palavra${i + 1}`,
    start: i,
    end: i + 0.5,
  }));
}

type ProjectFixture = {
  id: string;
  revision: number;
  previewRevision: number | null;
  preparation: null;
  corrections: unknown[];
  assembly: {
    name: string;
    fps: { num: number; den: number };
    width: number;
    height: number;
    sources: { id: string; name: string; included: boolean; hasVideo: boolean }[];
    tracks: unknown[];
  };
  analyses: { sourceId: string; status: string; words: ReturnType<typeof words>; visual: unknown[]; speech: unknown[] }[];
  scenes: {
    id: string;
    objective: string;
    rationale: string;
    takes: {
      id: string;
      sourceId: string;
      start: number;
      end: number;
      removed: { start: number; end: number }[];
      protected: { start: number; end: number }[];
    }[];
    support: unknown[];
    gaps: string[];
  }[];
};

function project(count = 6_000, sceneCount = 20): ProjectFixture {
  const analysisWords = words(count);
  const perScene = count / sceneCount;
  return {
    id: "p-u2",
    revision: 1,
    previewRevision: null,
    preparation: null,
    corrections: [],
    assembly: {
      name: "Montagem U2",
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [{ id: "a", name: "fala.mp4", included: true, hasVideo: false }],
      tracks: [],
    },
    analyses: [{ sourceId: "a", status: "ready", words: analysisWords, visual: [], speech: [] }],
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      id: `s${i + 1}`,
      objective: `Cena ${i + 1}`,
      rationale: "",
      takes: [{
        id: `t${i + 1}`,
        sourceId: "a",
        start: i * perScene,
        end: i * perScene + perScene - 0.5,
        removed: [],
        protected: [],
      }],
      support: [],
      gaps: [],
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
  win.dispatchEvent = (event) => {
    for (const listener of windowListeners.get(event.type) || []) listener();
  };
  const state = createState({ selection: new Set<string>(), playhead: null });
  const api = {
    call: vi.fn(async () => ({ res: { ok: true, status: 200 }, body: {} })),
    notifyError: vi.fn(),
  };
  const player = { seek: vi.fn(), playOriginal: vi.fn(), previewBusy: () => false };
  mountTexto({ state, api, player });
  state.set("project", p);
  return { state, api, player, document };
}

function toggleDetails(root: El, details: El) {
  details.querySelector("summary")!.click();
  details.open = !details.open;
  // O fake DOM não implementa o evento nativo de toggle/capture de <details>.
  root.dispatchEvent({ type: "toggle", target: details, bubbles: false });
}

function virtualGeometry(document: FakeDocument) {
  const originalRect = El.prototype.getBoundingClientRect;
  const originalScrollIntoView = (El.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
  const root = document.getElementById("texto")!;
  root.clientHeight = 200;
  root.scrollTop = 0;
  El.prototype.getBoundingClientRect = function () {
    if (this.id === "texto") return {
      left: 0, top: 0, right: 500, bottom: root.clientHeight,
      width: 500, height: root.clientHeight,
    };
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
    if (originalScrollIntoView) {
      (El.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = originalScrollIntoView;
    } else {
      delete (El.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
    }
  };
}

it("conta omitidos sem retornar/materializar catálogo e mantém paridade com a expansão", () => {
  const p = project(20, 2);
  const scene = p.scenes[0]!;
  expect(omittedWordCount(p, scene, "a")).toBe(10);
  expect(omittedWords(p, scene, "a").map((word) => word.id)).toEqual(
    ["w11", "w12", "w13", "w14", "w15", "w16", "w17", "w18", "w19", "w20"],
  );
  expect(omittedWordCount(p, scene, "missing-source")).toBe(0);
});

it("mantém a cena fechada quando muda palavra omitida e atualiza o catálogo aberto", () => {
  const original = project(20, 2);
  original.scenes[1]!.takes[0]!.end = 10.5;
  const { state, document } = mount(original);
  const root = document.getElementById("texto")!;
  const section = document.querySelector('[data-scene-section="s1"]')!;
  const keptButton = section.querySelector('[data-word-id="w1"]')!;
  const closedDetails = section.querySelector('details[data-omitted-source="a"]')!;

  const revised = project(20, 2);
  revised.scenes[1]!.takes[0]!.end = 10.5;
  revised.revision = 2;
  revised.analyses[0]!.words = revised.analyses[0]!.words.map((word) =>
    word.id === "w15"
      ? { ...word, id: "w15-revised", text: "palavra revisada", start: 14.1, end: 14.6 }
      : word,
  );
  expect(docSignature(revised)).toBe(docSignature(original));
  state.set("project", revised);

  expect(section.querySelector('[data-word-id="w1"]')).toBe(keptButton);
  expect(section.querySelector('details[data-omitted-source="a"]')).toBe(closedDetails);
  toggleDetails(root, closedDetails);
  expect(section.querySelector('[data-word-id="w15-revised"][aria-label="palavra revisada"]')).toBeTruthy();
  expect(section.querySelector('[data-word-id="w15"]')).toBeNull();

  const withNewOmittedWord: ProjectFixture = {
    ...revised,
    revision: 3,
    analyses: [{
      ...revised.analyses[0]!,
      words: [...revised.analyses[0]!.words, { id: "w21", text: "palavra nova", start: 20, end: 20.5 }],
    }],
  };
  state.set("project", withNewOmittedWord);

  const updatedSection = document.querySelector('[data-scene-section="s1"]')!;
  expect(omittedWordCount(withNewOmittedWord, withNewOmittedWord.scenes[0]!, "a")).toBe(11);
  expect(updatedSection.querySelector('[data-word-id="w21"][aria-label="palavra nova"]')).toBeTruthy();
  expect(updatedSection.querySelector('[data-word-id="w15-revised"][aria-label="palavra revisada"]')).toBeTruthy();
  expect(updatedSection.querySelector('details[data-omitted-source="a"]')!.open).toBe(true);
});

it("contagem omitida acompanha remoções e correção alinhada", () => {
  const removed = project(20, 2);
  removed.scenes[0]!.takes[0]!.removed = [{ start: 0, end: 2 }];
  expect(omittedWordCount(removed, removed.scenes[0]!, "a")).toBe(omittedWords(removed, removed.scenes[0]!, "a").length);
  expect(omittedWords(removed, removed.scenes[0]!, "a").map((word) => word.id).slice(0, 2)).toEqual(["w1", "w2"]);

  const corrected = project(20, 2);
  corrected.corrections = [{
    sourceId: "a",
    status: "aligned",
    start: 14,
    end: 14.5,
    words: [{ id: "a:sha:c:c1:w000001", text: "corrigida", start: 14, end: 14.5 }],
  }];
  expect(omittedWordCount(corrected, corrected.scenes[0]!, "a")).toBe(10);
  expect(omittedWords(corrected, corrected.scenes[0]!, "a").some((word) => word.id === "a:sha:c:c1:w000001")).toBe(true);
});

it("preserva foco da palavra ao mover e desfazer a ordem das cenas", () => {
  const { state, document } = mount(project(20, 2));
  const firstWord = document.querySelector('[data-scene="s1"][data-word-id="w1"]')!;
  firstWord.focus();
  expect(document.activeElement).toBe(firstWord);

  const originalInsertBefore = El.prototype.insertBefore;
  El.prototype.insertBefore = function (node: El, ref: El | null) {
    // Reproduz Chromium ao reordenar uma casca: mover uma filha pode desfocar
    // a palavra ativa que pertence à região .measure.
    if (this.classList.contains("measure") && node.parentElement === this && document.activeElement) {
      document.activeElement.blur();
    }
    return originalInsertBefore.call(this, node, ref);
  };
  try {
    const moved = project(20, 2);
    moved.revision = 2;
    moved.scenes = [moved.scenes[1]!, moved.scenes[0]!];
    state.set("project", moved);
    expect(document.activeElement?.getAttribute("data-word-id")).toBe("w1");
    expect(document.activeElement?.dataset.scene).toBe("s1");

    const undone = project(20, 2);
    undone.revision = 3;
    state.set("project", undone);
    expect(document.activeElement?.getAttribute("data-word-id")).toBe("w1");
    expect(document.activeElement?.dataset.scene).toBe("s1");
  } finally {
    El.prototype.insertBefore = originalInsertBefore;
  }
});

it("mantém os resumos de 6.000 palavras sem criar botões omitidos até expandir, sem reconstruir a cena", () => {
  const p = project();
  const { state, document } = mount(p);
  const root = document.getElementById("texto")!;
  const firstSection = document.querySelector('[data-scene-section="s1"]')!;
  const firstKeptWord = firstSection.querySelector("button.word")!;
  root.scrollTop = 137;

  const initiallyMountedWordCount = document.querySelectorAll("button.word").length;
  expect(initiallyMountedWordCount).toBeGreaterThan(0);
  expect(initiallyMountedWordCount).toBeLessThan(6_000);
  expect(document.querySelectorAll("[data-omitted-source][data-scene]").length).toBeGreaterThan(0);
  expect(document.querySelectorAll('button.word[data-take=""]').length).toBe(0);
  expect(omittedWordCount(p, p.scenes[0]!, "a")).toBe(5_700);
  expect(firstSection.querySelector(".unused-head .mono")).toBeTruthy();

  const details = firstSection.querySelector('details[data-omitted-source="a"][data-scene="s1"]')!;
  toggleDetails(root, details);

  expect(details.open).toBe(true);
  expect(document.querySelectorAll("button.word")).toHaveLength(initiallyMountedWordCount + 5_700);
  expect(document.querySelector('[data-scene-section="s1"]')).toBe(firstSection);
  expect(firstSection.querySelector("button.word")).toBe(firstKeptWord);
  expect(root.scrollTop).toBe(137);

  toggleDetails(root, details);
  expect(details.open).toBe(false);
  expect(firstSection.querySelectorAll('button.word[data-take=""]')).toHaveLength(0);
  expect(document.querySelectorAll("button.word")).toHaveLength(initiallyMountedWordCount);
  expect(state.get("selection")).toEqual(new Set());
});

it("preserva shells, monta só cenas próximas no scroll e remonta a cena selecionada", () => {
  const { state, document } = mount(project());
  const restore = virtualGeometry(document);
  try {
    const root = document.getElementById("texto")!;
    const sections = document.querySelectorAll("section[data-scene-section]");
    expect(sections).toHaveLength(20);
    expect(sections.every((section) => section.dataset.sceneMounted !== "true")).toBe(false);

    root.scrollTop = 3_000;
    root.dispatchEvent({ type: "scroll" });
    expect(document.querySelector('[data-scene-section="s1"]')).toBe(sections[0]);
    expect(document.querySelector('[data-scene-section="s11"]')).toBe(sections[10]);
    expect(sections[0]!.dataset.sceneMounted).not.toBe("true");
    expect(sections[10]!.dataset.sceneMounted).toBe("true");

    const mountedBeforeResize = sections.filter((section) => section.dataset.sceneMounted === "true").length;
    root.clientHeight = 1_000;
    (globalThis as unknown as { window: { dispatchEvent: (event: { type: string }) => void } })
      .window.dispatchEvent({ type: "resize" });
    expect(sections.filter((section) => section.dataset.sceneMounted === "true").length)
      .toBeGreaterThan(mountedBeforeResize);

    state.set("selectedScene", "s1");
    expect(sections[0]!.dataset.sceneMounted).toBe("true");
    expect(document.querySelector('[data-scene-section="s1"]')).toBe(sections[0]);
    state.set("selection", new Set(["s1\0t1\0w1"]));
    expect(sections[0]!.querySelector('[data-word-id="w1"]')!.getAttribute("aria-pressed")).toBe("true");

    const edited = project();
    edited.revision = 2;
    edited.scenes[0]!.takes[0]!.removed = [{ start: 0, end: 1 }];
    state.set("project", edited);
    expect(document.querySelector('[data-scene-section="s1"]')).toBe(sections[0]);
    expect(sections[0]!.querySelector('[data-word-id="w1"]')!.classList.contains("riscado")).toBe(true);
    expect(sections[0]!.querySelector('[data-word-id="w1"]')!.getAttribute("aria-pressed")).toBe("true");
    const restored = project();
    restored.revision = 3;
    state.set("project", restored);
    expect(document.querySelector('[data-scene-section="s1"]')).toBe(sections[0]);
    expect(sections[0]!.dataset.sceneMounted).toBe("true");
    expect(sections[0]!.querySelector('[data-word-id="w1"]')!.classList.contains("riscado")).toBe(false);
    expect(sections[0]!.querySelector('[data-word-id="w1"]')!.getAttribute("aria-pressed")).toBe("true");
  } finally {
    restore();
  }
});

it("mantém zona omitida aberta e seleção ao desmontar a cena e remontá-la com catálogo atualizado", () => {
  const p = project(20, 20);
  const { state, document } = mount(p);
  const restore = virtualGeometry(document);
  try {
    const root = document.getElementById("texto")!;
    const section = document.querySelector('[data-scene-section="s1"]')!;
    const details = section.querySelector('details[data-omitted-source="a"]')!;
    toggleDetails(root, details);
    const selectedOmittedWord = section.querySelector('[data-word-id="w3"][data-take=""]')!;
    selectedOmittedWord.click();
    expect(state.get("selection")).toEqual(new Set(["s1\0\0w3"]));
    expect(selectedOmittedWord.getAttribute("aria-pressed")).toBe("true");

    root.scrollTop = 3_000;
    root.dispatchEvent({ type: "scroll" });
    expect(section.dataset.sceneMounted).toBe("false");
    expect(section.querySelectorAll('button.word[data-take=""]').length).toBe(0);

    const revised = project(20, 20);
    revised.revision = 2;
    revised.analyses[0]!.words = revised.analyses[0]!.words.map((word) =>
      word.id === "w4" ? { ...word, text: "palavra atualizada" } : word,
    );
    state.set("project", revised);
    expect(section.dataset.sceneMounted).toBe("false");
    expect(state.get("selection")).toEqual(new Set(["s1\0\0w3"]));

    root.scrollTop = 0;
    root.dispatchEvent({ type: "scroll" });
    const remountedDetails = section.querySelector('details[data-omitted-source="a"]')!;
    expect(section.dataset.sceneMounted).toBe("true");
    expect(remountedDetails.open).toBe(true);
    expect(section.querySelector('[data-word-id="w3"][data-take=""][aria-pressed="true"]')).toBeTruthy();
    expect(section.querySelector('[data-word-id="w4"][aria-label="palavra atualizada"]')).toBeTruthy();
    expect(omittedWordCount(revised, revised.scenes[0]!, "a")).toBe(19);
  } finally {
    restore();
  }
});
