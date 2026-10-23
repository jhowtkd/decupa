// Refazer na faixa: botão e atalhos só no studio; a legacy não muda. O atalho é
// ligado uma vez por módulo, então cada teste importa o módulo de novo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { El, installDom } from "./fake-dom.test-helper.ts";

type Chamada = { path: string; body: { baseRevision: number; revision: number } };
type Resolve = (valor: { res: { ok: boolean }; body: object }) => void;

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const passo = (revision: number, label: string) => ({ revision, label });

function projeto(sobre: Record<string, unknown> = {}) {
  return {
    revision: 7,
    undo: { head: 7, steps: [passo(5, "Tirar trecho")], redo: [passo(2, "Outra"), passo(6, "Apagar cena")] },
    scenes: [],
    captions: [],
    corrections: [],
    analyses: [],
    assembly: { fps: { num: 25, den: 1 }, sources: [], tracks: [] },
    ...sobre,
  };
}

async function monta(ui?: "studio" | "legacy", sobre: Record<string, unknown> = {}, laterais: { undo?: number | null; redo?: number | null } = {}) {
  const document = installDom('<section id="faixa"></section><span id="undoSlot"></span>');
  vi.stubGlobal("HTMLElement", El);
  const { createState } = await import("./state.js");
  const { mountSequencia } = await import("./sequencia.js");
  const state = createState({});
  const chamadas: Chamada[] = [];
  const pendentes: Resolve[] = [];
  const api = {
    call: vi.fn((path: string, opts: { body: string }) => {
      chamadas.push({ path, body: JSON.parse(opts.body) as Chamada["body"] });
      return new Promise((resolve) => { pendentes.push(resolve as Resolve); });
    }),
  };
  state.set("undoRevision", laterais.undo === undefined ? 5 : laterais.undo);
  state.set("redoRevision", laterais.redo === undefined ? 6 : laterais.redo);
  state.set("project", projeto(sobre));
  const args = { state, api, player: { seek: vi.fn(), el: () => null } };
  if (ui === undefined) mountSequencia(args);
  else mountSequencia({ ...args, ui });
  const tecla = (ev: Record<string, unknown>) => {
    const evento = { type: "keydown", target: document.body, ...ev };
    document.dispatchEvent(evento);
  };
  const concluir = async (i = 0) => {
    pendentes[i]!({ res: { ok: true }, body: {} });
    await Promise.resolve();
    await Promise.resolve();
  };
  return { document, state, api, chamadas, tecla, concluir };
}

describe("legacy", () => {
  it.each([[undefined], ["legacy" as const]])("ui=%s: sem #redo; Ctrl/Cmd+Shift+Z e Ctrl+Y não chamam nada; Ctrl+Z desfaz", async (ui) => {
    const { document, tecla, chamadas } = await monta(ui);
    const redo = document.getElementById("redo");
    tecla({ key: "Z", ctrlKey: true, shiftKey: true });
    tecla({ key: "z", metaKey: true, shiftKey: true });
    tecla({ key: "y", ctrlKey: true });
    const semRefazer = chamadas.length;
    tecla({ key: "z", ctrlKey: true });
    expect({ redo, semRefazer, depois: chamadas.map((c) => c.path) }).toEqual({
      redo: null, semRefazer: 0, depois: ["project/undo"],
    });
  });
});

describe("studio", () => {
  it("#redo vem logo depois de #undo em #undoSlot, com título e nome acessível do passo", async () => {
    const { document } = await monta("studio");
    const slot = document.getElementById("undoSlot")!;
    const redo = document.getElementById("redo")!;
    expect({
      ids: slot.children.map((c) => c.id),
      title: redo.title,
      aria: redo.getAttribute("aria-label"),
      disabled: redo.disabled,
    }).toEqual({ ids: ["undo", "redo"], title: "Refazer: Apagar cena", aria: "Refazer: Apagar cena", disabled: false });
  });

  it.each([
    ["Cmd+Shift+Z", { key: "z", metaKey: true, shiftKey: true }],
    ["Ctrl+Shift+Z", { key: "Z", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Y", { key: "y", ctrlKey: true }],
  ])("%s chama project/redo com a base e o alvo do ramo", async (_nome, ev) => {
    const { tecla, chamadas } = await monta("studio");
    tecla(ev);
    expect(chamadas).toEqual([{ path: "project/redo", body: { baseRevision: 7, revision: 6 } }]);
  });

  it("clicar em #redo chama project/redo", async () => {
    const { document, chamadas } = await monta("studio");
    document.getElementById("redo")!.click();
    expect(chamadas.map((c) => c.path)).toEqual(["project/redo"]);
  });

  it.each([
    ["Cmd+Y", { key: "y", metaKey: true }],
    ["Alt+Ctrl+Shift+Z", { key: "z", ctrlKey: true, shiftKey: true, altKey: true }],
    ["Ctrl+Shift+Y", { key: "y", ctrlKey: true, shiftKey: true }],
  ])("%s não refaz", async (_nome, ev) => {
    const { tecla, chamadas } = await monta("studio");
    tecla(ev);
    expect(chamadas).toEqual([]);
  });

  it("Ctrl+Z continua desfazendo no studio", async () => {
    const { tecla, chamadas } = await monta("studio");
    tecla({ key: "z", ctrlKey: true });
    expect(chamadas).toEqual([{ path: "project/undo", body: { baseRevision: 7, revision: 5 } }]);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("foco em %s ignora o atalho", async (tag) => {
    const { document, tecla, chamadas } = await monta("studio");
    const campo = document.createElement(tag.toLowerCase());
    tecla({ key: "z", ctrlKey: true, shiftKey: true, target: campo });
    tecla({ key: "y", ctrlKey: true, target: campo });
    expect(chamadas).toEqual([]);
  });

  it("foco em contentEditable ignora o atalho", async () => {
    const { document, tecla, chamadas } = await monta("studio");
    const campo = document.createElement("div") as El & { isContentEditable: boolean };
    campo.isContentEditable = true;
    tecla({ key: "y", ctrlKey: true, target: campo });
    expect(chamadas).toEqual([]);
  });

  it("ramo de outra revisão (head velho) deixa #redo desabilitado e o atalho não chama", async () => {
    const { document, tecla, chamadas } = await monta("studio", {
      undo: { head: 6, steps: [passo(5, "Tirar trecho")], redo: [passo(6, "Apagar cena")] },
    });
    const redo = document.getElementById("redo")!;
    tecla({ key: "y", ctrlKey: true });
    expect({ disabled: redo.disabled, title: redo.title, chamadas: chamadas.length }).toEqual({
      disabled: true, title: "Nada desfeito para refazer", chamadas: 0,
    });
  });

  it("redoRevision diferente do topo ou ausente deixa #redo desabilitado", async () => {
    const outro = await monta("studio", {}, { redo: 2 });
    outro.tecla({ key: "y", ctrlKey: true });
    const outroDisabled = outro.document.getElementById("redo")!.disabled;
    const outroChamadas = outro.chamadas.length;

    vi.resetModules();
    const nulo = await monta("studio", {}, { redo: null });
    nulo.tecla({ key: "y", ctrlKey: true });
    expect({
      outro: [outroDisabled, outroChamadas],
      nulo: [nulo.document.getElementById("redo")!.disabled, nulo.chamadas.length],
    }).toEqual({ outro: [true, 0], nulo: [true, 0] });
  });

  it("sem ramo, #redo existe e fica desabilitado", async () => {
    const { document } = await monta("studio", { undo: { head: 7, steps: [passo(5, "Tirar trecho")] } });
    const redo = document.getElementById("redo")!;
    expect({ disabled: redo.disabled, aria: redo.getAttribute("aria-label") }).toEqual({ disabled: true, aria: "Refazer edição" });
  });

  it("com o refazer em voo, desfazer é ignorado, ambos ficam desabilitados e o voo libera ao assentar", async () => {
    const { document, tecla, chamadas, concluir } = await monta("studio");
    const undo = document.getElementById("undo")!;
    const redo = document.getElementById("redo")!;
    tecla({ key: "y", ctrlKey: true });
    tecla({ key: "z", ctrlKey: true });
    tecla({ key: "y", ctrlKey: true });
    undo.click();
    const durante = { chamadas: chamadas.map((c) => c.path), undo: undo.disabled, redo: redo.disabled, busy: redo.getAttribute("aria-busy") };
    await concluir();
    expect({ durante, redoDepois: redo.getAttribute("aria-busy") }).toEqual({
      durante: { chamadas: ["project/redo"], undo: true, redo: true, busy: "true" },
      redoDepois: "false",
    });
  });

  it("com o desfazer em voo, refazer é ignorado e vice-versa depois de assentar", async () => {
    const { document, tecla, chamadas, concluir } = await monta("studio");
    const redo = document.getElementById("redo")!;
    tecla({ key: "z", ctrlKey: true });
    tecla({ key: "y", ctrlKey: true });
    redo.click();
    const durante = { chamadas: chamadas.map((c) => c.path), redo: redo.disabled };
    await concluir();
    tecla({ key: "y", ctrlKey: true });
    expect({ durante, depois: chamadas.map((c) => c.path) }).toEqual({
      durante: { chamadas: ["project/undo"], redo: true },
      depois: ["project/undo", "project/redo"],
    });
  });

  it("o refazer lido do estado novo (redoRevision) reabilita o botão", async () => {
    const { document, state } = await monta("studio", {}, { redo: null });
    const redo = document.getElementById("redo")!;
    const antes = redo.disabled;
    state.set("redoRevision", 6);
    expect({ antes, depois: redo.disabled }).toEqual({ antes: true, depois: false });
  });
});

describe("atalhos com o #undoSlot escondido", () => {
  const ATALHOS: Array<[string, Record<string, unknown>]> = [
    ["Ctrl+Z", { key: "z", ctrlKey: true }],
    ["Cmd+Z", { key: "z", metaKey: true }],
    ["Ctrl+Shift+Z", { key: "Z", ctrlKey: true, shiftKey: true }],
    ["Cmd+Shift+Z", { key: "z", metaKey: true, shiftKey: true }],
    ["Ctrl+Y", { key: "y", ctrlKey: true }],
  ];
  const aparencia = (document: ReturnType<typeof installDom>, visivel: boolean) => {
    const slot = document.getElementById("undoSlot")! as unknown as { getClientRects: () => unknown[] };
    slot.getClientRects = () => (visivel ? [{}] : []);
  };

  it("studio escondido: nenhum atalho chama a API", async () => {
    const { document, tecla, chamadas } = await monta("studio");
    aparencia(document, false);
    for (const [, ev] of ATALHOS) tecla(ev);
    expect(chamadas).toEqual([]);
  });

  it("studio visível: os atalhos chamam como antes", async () => {
    const { document, tecla, chamadas } = await monta("studio");
    aparencia(document, true);
    tecla({ key: "z", ctrlKey: true });
    expect(chamadas.map((c) => c.path)).toEqual(["project/undo"]);
  });

  it.each(ATALHOS.filter(([nome]) => nome.includes("Shift") || nome === "Ctrl+Y"))("studio visível: %s refaz", async (_nome, ev) => {
    const { document, tecla, chamadas } = await monta("studio");
    aparencia(document, true);
    tecla(ev);
    expect(chamadas.map((c) => c.path)).toEqual(["project/redo"]);
  });

  it("legacy escondido: Ctrl+Z continua desfazendo", async () => {
    const { document, tecla, chamadas } = await monta("legacy");
    aparencia(document, false);
    tecla({ key: "z", ctrlKey: true });
    expect(chamadas.map((c) => c.path)).toEqual(["project/undo"]);
  });
});

describe("puras", () => {
  it("redoView espelha undoView", async () => {
    const { redoView } = await import("./sequencia.js");
    const p = projeto();
    expect([
      redoView(p, 6, false),
      redoView(p, 6, true),
      redoView(p, 2, false).disabled,
      redoView(p, null, false).disabled,
      redoView({ ...p, undo: { ...p.undo, head: 1 } }, 6, false).disabled,
      redoView(null, 6, false).disabled,
    ]).toEqual([
      { disabled: false, busy: false, title: "Refazer: Apagar cena", text: "Apagar cena" },
      { disabled: true, busy: true, title: "Refazendo…", text: "Apagar cena" },
      true, true, true, true,
    ]);
  });

  it("historyKey: studio refaz com Cmd/Ctrl+Shift+Z e Ctrl+Y; legacy só desfaz", async () => {
    const { historyKey } = await import("./sequencia.js");
    const evs = {
      z: { key: "z", ctrlKey: true },
      cmdZ: { key: "z", metaKey: true },
      sz: { key: "Z", ctrlKey: true, shiftKey: true },
      msz: { key: "z", metaKey: true, shiftKey: true },
      y: { key: "y", ctrlKey: true },
      cmdY: { key: "y", metaKey: true },
      altZ: { key: "z", ctrlKey: true, altKey: true },
      puro: { key: "z" },
      outro: { key: "x", ctrlKey: true },
    };
    const mapa = (ui: string) => Object.values(evs).map((ev) => historyKey(ev, ui));
    expect({ studio: mapa("studio"), legacy: mapa("legacy") }).toEqual({
      studio: ["undo", "undo", "redo", "redo", "redo", null, null, null, null],
      legacy: ["undo", "undo", null, null, null, null, null, null, null],
    });
  });
});
