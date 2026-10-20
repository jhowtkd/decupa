import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { mountTexto, selectionKey } from "./texto.js";
import { installDom, type FakeDocument, type El } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function projeto() {
  const words = [
    { id: "a1", text: "primeira", start: 0, end: 0.4 },
    { id: "a2", text: "segunda", start: 0.4, end: 0.8 },
    { id: "a3", text: "terceira", start: 0.8, end: 1.2 },
    { id: "b1", text: "quarta", start: 1.2, end: 1.6 },
  ];
  return {
    id: "p",
    revision: 1,
    previewRevision: null as number | null,
    preparation: null,
    corrections: [],
    assembly: {
      name: "Montagem",
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [{ id: "source", name: "fala.mp4", included: true, hasVideo: false }],
      tracks: [],
    },
    analyses: [{
      sourceId: "source",
      status: "ready",
      words,
      visual: [{ id: "visual-1", sourceId: "source", start: 1.2, end: 2.2, text: "Plano de apoio" }],
      speech: [],
    }],
    scenes: [
      {
        id: "scene-a",
        objective: "Cena A",
        rationale: "",
        takes: [{
          id: "take-a", sourceId: "source", start: 0, end: 1.2,
          removed: [] as Array<{ start: number; end: number }>,
          protected: [] as Array<{ start: number; end: number }>,
        }],
        support: [],
        gaps: [],
      },
      {
        id: "scene-b",
        objective: "Cena B",
        rationale: "",
        takes: [{
          id: "take-b", sourceId: "source", start: 1.2, end: 1.6,
          removed: [] as Array<{ start: number; end: number }>,
          protected: [] as Array<{ start: number; end: number }>,
        }],
        support: [{ visualId: "visual-1", offsetFrames: 30, durationFrames: 25 }],
        gaps: [],
      },
    ],
  };
}

function montar() {
  const document = installDom('<section id="texto"></section><div id="dropzone" hidden></div>');
  const state = createState({ selection: new Set<string>(), playhead: null });
  const calls: unknown[][] = [];
  const api = {
    call: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { res: { ok: true, status: 200 }, body: {} };
    }),
    notifyError: vi.fn(),
  };
  mountTexto({ state, api, player: { seek: vi.fn(), previewBusy: () => false } });
  state.set("project", projeto());
  return { state, api, calls, document };
}

function words(document: FakeDocument): El[] {
  return document.querySelectorAll("button.word");
}

function key(target: El, key: string, shiftKey = false) {
  target.dispatchEvent({ type: "keydown", key, shiftKey });
}

function bodyAt(calls: unknown[][], index: number) {
  const options = calls[index]?.[1] as { body?: string } | undefined;
  return JSON.parse(options?.body ?? "{}");
}

function activateByKeyboard(target: El, key = "Enter") {
  keyEvent(target, key);
  // fake-dom deliberately does not implement the browser's native button activation default.
  target.click();
}

function keyEvent(target: El, key: string) {
  target.dispatchEvent({ type: "keydown", key });
}

it("mantém um ponto de Tab por bloco e as setas deslocam o foco na ordem do documento", () => {
  const { document } = montar();
  const rendered = words(document);
  const blocks = document.querySelectorAll(".prose");

  expect(blocks).toHaveLength(4); // Dois takes e duas zonas omitidas recolhidas.
  expect(blocks.map((block) => block.querySelectorAll('button.word[tabindex="0"]').length)).toEqual([1, 1, 1, 1]);
  expect(rendered.filter((word) => !word.closest("details") || word.closest("details")!.open)
    .map((word) => word.getAttribute("tabindex")))
    .toEqual(["0", "-1", "-1", "0"]);

  rendered[0]!.focus();
  key(rendered[0]!, "ArrowRight");
  expect(document.activeElement?.dataset.wordId).toBe("a2");
  key(document.activeElement!, "ArrowRight");
  expect(document.activeElement?.dataset.wordId).toBe("a3");
  key(document.activeElement!, "ArrowRight");
  expect(document.activeElement?.dataset.wordId).toBe("b1");
});

it("Shift+seta mantém o intervalo contíguo e permite reduzi-lo pela âncora", () => {
  const { state, document } = montar();
  const rendered = words(document);
  rendered[0]!.focus();

  key(rendered[0]!, "ArrowRight", true);
  key(document.activeElement!, "ArrowRight", true);
  expect([...state.get("selection")]).toEqual([
    selectionKey("scene-a", "take-a", "a1"),
    selectionKey("scene-a", "take-a", "a2"),
    selectionKey("scene-a", "take-a", "a3"),
  ]);

  key(document.activeElement!, "ArrowLeft", true);
  expect([...state.get("selection")]).toEqual([
    selectionKey("scene-a", "take-a", "a1"),
    selectionKey("scene-a", "take-a", "a2"),
  ]);
});

it("Shift+F10 abre ações e Escape fecha o menu devolvendo foco à palavra", () => {
  const { document } = montar();
  const first = words(document)[0]!;
  first.focus();
  key(first, "F10", true);

  const menu = document.querySelector('[aria-label="Ações do trecho"]');
  expect(menu).toBeTruthy();
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  key(document.activeElement!, "Escape");
  expect(document.querySelector('[aria-label="Ações do trecho"]')).toBeNull();
  expect(document.activeElement?.dataset.wordId).toBe("a1");
});

it("Space abre ações para a palavra focada", () => {
  const { document } = montar();
  const first = words(document)[0]!;
  first.focus();
  key(first, " ");

  expect(document.querySelector('[aria-label="Ações do trecho"]')).toBeTruthy();
});

it("menu usa setas e Enter para cortar; depois o foco da palavra sobrevive ao render", async () => {
  const { state, calls, document } = montar();
  const first = words(document)[0]!;
  first.focus();
  key(first, "ArrowRight", true);
  key(document.activeElement!, "Enter");
  const menu = document.querySelector('[aria-label="Ações do trecho"]')!;
  const actions = menu.querySelectorAll('[role="menuitem"]');
  expect(document.activeElement?.textContent).toBe("Ouvir");
  key(document.activeElement!, "ArrowDown");
  expect(document.activeElement?.textContent).toBe("Tirar");
  activateByKeyboard(document.activeElement!);
  await Promise.resolve();
  const body = bodyAt(calls, 0);
  expect(body.action).toMatchObject({ type: "remove", wordIds: ["a1", "a2"] });
  expect(actions).toHaveLength(4);

  const updated = projeto();
  updated.revision += 1;
  updated.analyses[0]!.words[1]!.text = "segunda atualizada";
  state.set("project", updated);
  expect(document.activeElement?.dataset.wordId).toBe("a2");
});

it("palavra removida abre Restaurar por teclado e corrige pelo formulário do menu", async () => {
  const { state, calls, document } = montar();
  const updated = projeto();
  updated.scenes[0]!.takes[0]!.removed = [{ start: 0, end: 0.4 }];
  state.set("project", updated);
  const removed = words(document)[0]!;
  removed.focus();
  key(removed, "Enter");
  key(document.activeElement!, "ArrowDown");
  expect(document.activeElement?.textContent).toBe("Restaurar");
  activateByKeyboard(document.activeElement!);
  await Promise.resolve();
  expect(bodyAt(calls, 0).action)
    .toMatchObject({ type: "restore", wordIds: ["a1"] });

  const live = words(document)[1]!;
  live.focus();
  key(live, "Enter");
  key(document.activeElement!, "End");
  expect(document.activeElement?.textContent).toBe("Corrigir");
  activateByKeyboard(document.activeElement!);
  const input = document.querySelector('input[aria-label="Correção do trecho"]')!;
  expect(document.activeElement).toBe(input);
  input.value = "segunda corrigida";
  document.querySelector(".texto-correct")!.dispatchEvent({
    type: "submit",
    preventDefault() {},
  });
  await Promise.resolve();
  await Promise.resolve();
  const correction = bodyAt(calls, 1);
  expect(correction.action).toMatchObject({ type: "correct", text: "segunda corrigida" });
});

it("chip de apoio escolhe explicitamente cena B e o id do grupo de apoio", () => {
  const { state, document } = montar();
  document.querySelector(".chip-apoio")!.click();
  expect(state.get("selectedScene")).toBe("scene-b");
  expect(state.get("selectedSupport")).toBe("visual-1:30");
  expect([...state.get("selection")]).toEqual([selectionKey("scene-b", "take-b", "b1")]);
});

function alinhado() {
  const p = projeto();
  return {
    ...p,
    corrections: [{
      sourceId: "source",
      start: 0.4,
      end: 1.2,
      status: "aligned",
      words: [{ id: "c-final", text: "final", start: 0.4, end: 1.2 }],
    }],
  };
}

it("após snapshot alinhado que troca duas palavras por uma, mantém foco no take e cena originais", () => {
  const { state, document } = montar();
  const before = document.querySelector('button.word[data-scene="scene-a"][data-take="take-a"][data-word-id="a3"]')!;
  before.focus();

  state.set("project", alinhado());

  expect({
    scene: document.activeElement?.dataset.scene,
    take: document.activeElement?.dataset.take,
    wordId: document.activeElement?.dataset.wordId,
  }).toEqual({
    scene: "scene-a",
    take: "take-a",
    wordId: "c-final",
  });
  expect(document.activeElement?.closest("details")?.open ?? true).toBe(true);
});

it("preserva expansão e foco ao realinhar uma palavra que estava em omitidos expandidos", () => {
  const { state, document } = montar();
  const expandedZone = document.querySelectorAll("details")[1]!;
  expandedZone.open = true;
  const before = expandedZone.querySelector('button.word[data-word-id="a2"]')!;
  before.focus();

  state.set("project", alinhado());

  expect({
    scene: document.activeElement?.dataset.scene,
    take: document.activeElement?.dataset.take,
    wordId: document.activeElement?.dataset.wordId,
  }).toEqual({
    scene: "scene-b",
    take: "",
    wordId: "c-final",
  });
  expect(document.activeElement?.closest("details")?.open).toBe(true);
});

it("click assistivo na ponta selecionada abre menu sem reduzir o intervalo", () => {
  const { state, document } = montar();
  const first = document.querySelector('button.word[data-scene="scene-a"][data-take="take-a"][data-word-id="a1"]')!;
  first.focus();
  key(first, "ArrowRight", true);
  key(document.activeElement!, "ArrowRight", true);
  expect([...state.get("selection")]).toEqual([
    selectionKey("scene-a", "take-a", "a1"),
    selectionKey("scene-a", "take-a", "a2"),
    selectionKey("scene-a", "take-a", "a3"),
  ]);

  document.activeElement!.dispatchEvent({ type: "click", detail: 0 } as never);

  expect([...state.get("selection")]).toEqual([
    selectionKey("scene-a", "take-a", "a1"),
    selectionKey("scene-a", "take-a", "a2"),
    selectionKey("scene-a", "take-a", "a3"),
  ]);
  expect(document.querySelector('[aria-label="Ações do trecho"]')).toBeTruthy();
});
