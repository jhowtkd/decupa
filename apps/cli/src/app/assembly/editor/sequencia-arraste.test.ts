// Arraste de cenas na faixa do studio: funções puras, alças, ponteiro, teclado,
// guarda do gesto e atalhos de histórico. O módulo liga o atalho global uma vez,
// então cada teste importa de novo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { El, installDom } from "./fake-dom.test-helper.ts";

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const take = (id: string, end: number) => ({ id, sourceId: "a", start: 0, end, removed: [], protected: [] });
const cena = (id: string, end: number) => ({ id, objective: "Cena " + id, takes: [take("t" + id, end)], support: [], gaps: [] });

/** 10 s: s1 4 s, s2 2 s, s3 4 s. */
function projeto(sobre: Record<string, unknown> = {}, cenas = [cena("s1", 4), cena("s2", 2), cena("s3", 4)]) {
  return {
    revision: 3,
    scenes: cenas,
    captions: [],
    corrections: [],
    analyses: [{ sourceId: "a", words: [], visual: [] }],
    assembly: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sources: [{ id: "a", name: "fala.mp4", hasVideo: true, hasAudio: true }], tracks: [] },
    ...sobre,
  };
}

type Pedido = { path: string; opts: { body: string; label?: string } };

async function monta(opcoes: { ui?: "studio" | "legacy"; project?: unknown; undoRevision?: number | null; selectedScene?: string } = {}) {
  const document = installDom('<section id="faixa"></section><span id="undoSlot"></span>');
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) })));
  const { createState } = await import("./state.js");
  const mod = await import("./sequencia.js");
  const state = createState({});
  const pedidos: Pedido[] = [];
  const pendentes: Array<() => void> = [];
  const api = {
    call: vi.fn((path: string, opts: { body: string; label?: string }) => {
      pedidos.push({ path, opts });
      return new Promise((resolve) => { pendentes.push(() => resolve({ res: { ok: true }, body: {} })); });
    }),
  };
  const player = { seek: vi.fn(), el: () => null };
  state.set("undoRevision", opcoes.undoRevision === undefined ? null : opcoes.undoRevision);
  if (opcoes.selectedScene) state.set("selectedScene", opcoes.selectedScene);
  state.set("project", opcoes.project ?? projeto());
  mod.mountSequencia({ state, api, player, ui: opcoes.ui ?? "studio" } as never);
  const faixa = document.getElementById("faixa")!;
  /** 1000 px de largura para a tira: os meios das cenas ficam em 200, 500 e 800. */
  const medir = () => {
    for (const strip of faixa.querySelectorAll(".seq-strip")) {
      strip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 40, width: 1000, height: 40 });
    }
  };
  medir();
  const alca = (id: string) => faixa.querySelector(`.bloco-alca[data-alca="${id}"]`)!;
  const ponteiro = (alvo: El, type: string, clientX: number) =>
    alvo.dispatchEvent({ type, clientX, pointerId: 1, button: 0 } as never);
  const tecla = (alvo: El, key: string, extra: Record<string, unknown> = {}) =>
    alvo.dispatchEvent({ type: "keydown", key, ...extra } as never);
  const esc = () => document.dispatchEvent({ type: "keydown", key: "Escape" });
  const concluir = async (i = 0) => {
    pendentes[i]!();
    for (let k = 0; k < 4; k++) await Promise.resolve();
  };
  const edits = () => pedidos.filter((p) => p.path === "project/edit");
  return { document, state, api, player, faixa, mod, medir, alca, ponteiro, tecla, esc, concluir, pedidos, edits };
}

const corpo = (p: Pedido) => JSON.parse(p.opts.body) as { baseRevision: number; action: { type: string; order: string[] } };

describe("funções puras", () => {
  it("ordemMovida leva a cena à posição e devolve null quando nada muda", async () => {
    const { ordemMovida } = await import("./sequencia.js");
    const ids = ["a", "b", "c", "d"];
    expect(ordemMovida(ids, "a", 3)).toEqual(["b", "c", "d", "a"]);
    expect(ordemMovida(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(ordemMovida(ids, "b", 2)).toEqual(["a", "c", "b", "d"]);
    expect(ordemMovida(ids, "b", 1)).toBeNull();
    expect(ordemMovida(ids, "x", 1)).toBeNull();
    expect(ordemMovida(ids, "a", 4)).toBeNull();
    expect(ordemMovida(ids, "a", -1)).toBeNull();
    expect(ordemMovida(ids, "a", 1.5)).toBeNull();
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("destinoDoArraste conta as outras cenas com o meio antes de t (inclui o próprio lugar)", async () => {
    const { destinoDoArraste } = await import("./sequencia.js");
    const blocos = [{ start: 0, end: 4 }, { start: 4, end: 6 }, { start: 6, end: 10 }]; // meios: 2, 5, 8
    expect(destinoDoArraste(blocos, 0, 0)).toBe(0);
    expect(destinoDoArraste(blocos, 0, 4.9)).toBe(0);
    expect(destinoDoArraste(blocos, 0, 5.1)).toBe(1);
    expect(destinoDoArraste(blocos, 0, 10)).toBe(2);
    expect(destinoDoArraste(blocos, 1, 3)).toBe(1); // sobre o próprio lugar
    expect(destinoDoArraste(blocos, 1, 0)).toBe(0);
    expect(destinoDoArraste(blocos, 1, 9)).toBe(2);
    expect(destinoDoArraste(blocos, 2, 1)).toBe(0);
  });

  it("fronteiraDoDestino: antes da cena que ocupa o lugar ao subir, depois dela ao descer, null no próprio lugar", async () => {
    const { fronteiraDoDestino } = await import("./sequencia.js");
    const blocos = [{ start: 0, end: 4 }, { start: 4, end: 6 }, { start: 6, end: 10 }];
    expect(fronteiraDoDestino(blocos, 2, 0)).toBe(0);
    expect(fronteiraDoDestino(blocos, 2, 1)).toBe(4);
    expect(fronteiraDoDestino(blocos, 0, 2)).toBe(10);
    expect(fronteiraDoDestino(blocos, 0, 1)).toBe(6);
    expect(fronteiraDoDestino(blocos, 1, 1)).toBeNull();
    expect(fronteiraDoDestino(blocos, 0, 7)).toBeNull();
  });

  it("anuncioDoArraste e as constantes do gesto", async () => {
    const { anuncioDoArraste, ARRASTE_LIMIAR_PX, ARRASTE_BORDA_PX } = await import("./sequencia.js");
    expect(anuncioDoArraste(2, 3, 5)).toBe("Cena 2 · posição 4 de 5");
    expect(anuncioDoArraste(1, 0, 1)).toBe("Cena 1 · posição 1 de 1");
    expect({ ARRASTE_LIMIAR_PX, ARRASTE_BORDA_PX }).toEqual({ ARRASTE_LIMIAR_PX: 4, ARRASTE_BORDA_PX: 32 });
  });

  it("enviarOrdem faz um project/edit com a revisão e a ordem inteira", async () => {
    const { enviarOrdem } = await import("./sequencia.js");
    const call = vi.fn(async () => ({}));
    await enviarOrdem({ call }, { revision: 9 }, ["b", "a"]);
    expect(call).toHaveBeenCalledTimes(1);
    const [path, opts] = call.mock.calls[0] as unknown as [string, { method: string; body: string; label: string }];
    expect(path).toBe("project/edit");
    expect(opts.method).toBe("POST");
    expect(opts.label).toBe("Movendo cena…");
    expect(JSON.parse(opts.body)).toEqual({ baseRevision: 9, action: { type: "reorder-scenes", order: ["b", "a"] } });
  });
});

describe("alças", () => {
  it("studio com 3 cenas: .faixa-alcas fora de .seq-strip, uma alça por cena, Tab só na selecionada ou na primeira", async () => {
    const { faixa } = await monta();
    const grupo = faixa.querySelector(".faixa-alcas")!;
    const strip = faixa.querySelector(".seq-strip")!;
    expect(grupo.getAttribute("role")).toBe("group");
    expect(grupo.parentElement!.className).toContain("faixa-trilhas");
    expect(strip.contains(grupo)).toBe(false);
    expect(strip.querySelector(".bloco-alca")).toBeNull();
    expect(faixa.querySelectorAll(".bloco-alca").map((b) => b.dataset.alca)).toEqual(["s1", "s2", "s3"]);
    expect(faixa.querySelectorAll(".bloco-alca").map((b) => b.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(faixa.querySelector(".faixa-destino")!.hidden).toBe(true);
    expect(faixa.querySelector("p.faixa-anuncio")!.getAttribute("aria-live")).toBe("polite");

    vi.unstubAllGlobals();
    vi.resetModules();
    const outra = await monta({ selectedScene: "s3" });
    expect(outra.faixa.querySelectorAll(".bloco-alca").map((b) => b.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it("a parada de Tab acompanha a cena selecionada sem redesenho; seleção sem alça mantém a atual", async () => {
    const { faixa, state } = await monta();
    const strip = faixa.querySelector(".seq-strip")!;
    const tabs = () => faixa.querySelectorAll(".bloco-alca").map((b) => b.tabIndex);
    state.set("selectedScene", "s2");
    expect(tabs()).toEqual([-1, 0, -1]);
    state.set("selectedScene", null);
    expect(tabs()).toEqual([-1, 0, -1]);
    state.set("selectedScene", "s9");
    expect(tabs()).toEqual([-1, 0, -1]);
    expect(faixa.querySelector(".seq-strip")).toBe(strip);
  });

  it("uma cena só: sem alças; legacy: sem .faixa-alcas mesmo com várias cenas", async () => {
    const uma = await monta({ project: projeto({}, [cena("s1", 4)]) });
    expect(uma.faixa.querySelector(".faixa-alcas")).toBeNull();
    expect(uma.faixa.querySelectorAll(".bloco-alca")).toHaveLength(0);

    vi.unstubAllGlobals();
    vi.resetModules();
    const legacy = await monta({ ui: "legacy" });
    expect(legacy.faixa.querySelector(".faixa-alcas")).toBeNull();
    expect(legacy.faixa.querySelectorAll(".bloco-alca")).toHaveLength(0);
    expect(legacy.faixa.querySelector("p.faixa-anuncio")).toBeNull();
  });
});

describe("ponteiro", () => {
  it("arraste completo gera um project/edit com a ordem inteira e a revisão da tela", async () => {
    const { alca, ponteiro, edits, concluir, api } = await monta();
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 300);
    ponteiro(a, "pointermove", 600);
    ponteiro(a, "pointermove", 900);
    expect(api.call).not.toHaveBeenCalled();
    ponteiro(a, "pointerup", 900);
    expect(edits()).toHaveLength(1);
    expect(corpo(edits()[0]!)).toEqual({ baseRevision: 3, action: { type: "reorder-scenes", order: ["s2", "s3", "s1"] } });
    expect(edits()[0]!.opts.label).toBe("Movendo cena…");
    await concluir();
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it("arrastar para trás: s3 até o começo vira [s3, s1, s2]", async () => {
    const { alca, ponteiro, edits } = await monta();
    const a = alca("s3");
    ponteiro(a, "pointerdown", 900);
    ponteiro(a, "pointermove", 500);
    ponteiro(a, "pointermove", 10);
    ponteiro(a, "pointerup", 10);
    expect(corpo(edits()[0]!).action.order).toEqual(["s3", "s1", "s2"]);
  });

  it("o pedido leva a revisão do momento em que pegou, não a de depois", async () => {
    const { alca, ponteiro, edits, state } = await monta();
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 900);
    state.set("project", projeto({ revision: 4 }));
    ponteiro(a, "pointerup", 900);
    expect(corpo(edits()[0]!).baseRevision).toBe(3);
  });

  it("soltar no mesmo lugar não envia nada", async () => {
    const { alca, ponteiro, api } = await monta();
    const a = alca("s2");
    ponteiro(a, "pointerdown", 500);
    ponteiro(a, "pointermove", 700);
    ponteiro(a, "pointermove", 480);
    ponteiro(a, "pointerup", 480);
    expect(api.call).not.toHaveBeenCalled();
  });

  it("clique sem passar de 4 px não chama api e seleciona a cena", async () => {
    const { alca, ponteiro, api, state } = await monta();
    state.set("selectedSupport", "v1");
    const a = alca("s2");
    ponteiro(a, "pointerdown", 500);
    ponteiro(a, "pointermove", 503);
    ponteiro(a, "pointerup", 503);
    expect(api.call).not.toHaveBeenCalled();
    expect({ cena: state.get("selectedScene"), apoio: state.get("selectedSupport") }).toEqual({ cena: "s2", apoio: null });
  });

  it("4 px já ativam o arraste (limiar inclusivo)", async () => {
    const { alca, ponteiro, api, state } = await monta();
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 104);
    ponteiro(a, "pointermove", 900);
    ponteiro(a, "pointerup", 900);
    expect(api.call).toHaveBeenCalledTimes(1);
    expect(state.get("selectedScene")).not.toBe("s1");
  });

  it("o pointerdown na alça não busca nem faz scrub", async () => {
    const { alca, ponteiro, player, state } = await monta();
    const a = alca("s2");
    const antes = state.get("playhead");
    ponteiro(a, "pointerdown", 500);
    ponteiro(a, "pointermove", 700);
    ponteiro(a, "pointerup", 700);
    expect(player.seek).not.toHaveBeenCalled();
    expect(state.get("playhead")).toBe(antes);
  });

  it("botão que não é o principal não pega a cena", async () => {
    const { alca, faixa, api } = await monta();
    const a = alca("s1");
    a.dispatchEvent({ type: "pointerdown", clientX: 100, pointerId: 1, button: 2 } as never);
    a.dispatchEvent({ type: "pointermove", clientX: 900, pointerId: 1 } as never);
    a.dispatchEvent({ type: "pointerup", clientX: 900, pointerId: 1 } as never);
    expect(api.call).not.toHaveBeenCalled();
    expect(faixa.classList.contains("reordenando")).toBe(false);
  });

  it("Esc no meio cancela sem chamar nada e solta a guarda", async () => {
    const { alca, ponteiro, esc, api, faixa } = await monta();
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 900);
    expect(faixa.classList.contains("reordenando")).toBe(true);
    esc();
    ponteiro(a, "pointerup", 900);
    expect(api.call).not.toHaveBeenCalled();
    expect(faixa.classList.contains("reordenando")).toBe(false);
    expect(faixa.querySelectorAll(".arrastando")).toHaveLength(0);
  });

  it("pointercancel e lostpointercapture cancelam", async () => {
    for (const fim of ["pointercancel", "lostpointercapture"]) {
      vi.unstubAllGlobals();
      vi.resetModules();
      const { alca, ponteiro, api, faixa } = await monta();
      const a = alca("s1");
      ponteiro(a, "pointerdown", 100);
      ponteiro(a, "pointermove", 900);
      ponteiro(a, fim, 900);
      ponteiro(a, "pointerup", 900);
      expect(api.call, fim).not.toHaveBeenCalled();
      expect(faixa.classList.contains("reordenando"), fim).toBe(false);
    }
  });

  it("legacy: pointerdown em .bloco-alca não existe e o scrub segue o caminho antigo", async () => {
    const { faixa, api } = await monta({ ui: "legacy" });
    expect(faixa.querySelector(".bloco-alca")).toBeNull();
    expect(api.call).not.toHaveBeenCalled();
  });
});

describe("teclado", () => {
  it("pegar, →→ e soltar: uma chamada com a cena duas posições à frente", async () => {
    const { alca, tecla, edits, faixa } = await monta();
    const a = alca("s1");
    a.focus();
    tecla(a, " ");
    tecla(a, "ArrowRight");
    tecla(a, "ArrowRight");
    expect(faixa.querySelector(".faixa-anuncio")!.textContent).toBe("Cena 1 · posição 3 de 3");
    expect(edits()).toHaveLength(0);
    tecla(a, " ");
    expect(edits()).toHaveLength(1);
    expect(corpo(edits()[0]!)).toEqual({ baseRevision: 3, action: { type: "reorder-scenes", order: ["s2", "s3", "s1"] } });
  });

  it("Enter pega e solta; Home e End vão às pontas e as setas não passam delas", async () => {
    const { alca, tecla, edits } = await monta();
    const a = alca("s2");
    a.focus();
    tecla(a, "Enter");
    tecla(a, "End");
    tecla(a, "ArrowRight");
    tecla(a, "Enter");
    expect(corpo(edits()[0]!).action.order).toEqual(["s1", "s3", "s2"]);
  });

  it("Home leva a cena ao começo", async () => {
    const { alca, tecla, edits } = await monta();
    const a = alca("s3");
    a.focus();
    tecla(a, " ");
    tecla(a, "Home");
    tecla(a, " ");
    expect(corpo(edits()[0]!).action.order).toEqual(["s3", "s1", "s2"]);
  });

  it("soltar no lugar de origem não envia nada", async () => {
    const { alca, tecla, api, faixa } = await monta();
    const a = alca("s2");
    a.focus();
    tecla(a, " ");
    tecla(a, "ArrowRight");
    tecla(a, "ArrowLeft");
    tecla(a, " ");
    expect(api.call).not.toHaveBeenCalled();
    expect(faixa.querySelector(".faixa-anuncio")!.textContent).toBe("Cena no mesmo lugar");
  });

  it("Esc cancela sem chamar nada", async () => {
    const { alca, tecla, esc, api, faixa } = await monta();
    const a = alca("s1");
    a.focus();
    tecla(a, " ");
    tecla(a, "ArrowRight");
    esc();
    expect(faixa.querySelector(".faixa-anuncio")!.textContent).toContain("Movimento cancelado");
    expect(faixa.classList.contains("reordenando")).toBe(false);
    // o Espaço depois do Esc pega de novo, não solta: nada foi enviado
    tecla(a, " ");
    expect(api.call).not.toHaveBeenCalled();
  });

  it("perder o foco da alça (focusout) cancela", async () => {
    const { alca, tecla, api, faixa } = await monta();
    const a = alca("s1");
    a.focus();
    tecla(a, " ");
    tecla(a, "ArrowRight");
    a.dispatchEvent({ type: "focusout" });
    expect(faixa.classList.contains("reordenando")).toBe(false);
    expect(api.call).not.toHaveBeenCalled();
  });

  it("sem cena pega, as setas e Home/End movem o foco entre as alças e nada é enviado", async () => {
    const { alca, tecla, api, document } = await monta();
    const a = alca("s1");
    a.focus();
    tecla(a, "ArrowRight");
    expect(document.activeElement).toBe(alca("s2"));
    tecla(alca("s2"), "End");
    expect(document.activeElement).toBe(alca("s3"));
    tecla(alca("s3"), "ArrowRight");
    expect(document.activeElement).toBe(alca("s3"));
    tecla(alca("s3"), "Home");
    expect(document.activeElement).toBe(alca("s1"));
    expect(alca("s1").tabIndex).toBe(0);
    expect(alca("s2").tabIndex).toBe(-1);
    expect(api.call).not.toHaveBeenCalled();
  });
});

describe("guarda do gesto", () => {
  it("project e legendasFaixa no meio do gesto não trocam o DOM; depois do fim, redesenha", async () => {
    const { alca, ponteiro, state, faixa, concluir, medir } = await monta();
    const strip = faixa.querySelector(".seq-strip")!;
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 900);

    state.set("project", projeto({ revision: 4, scenes: [cena("s1", 4), cena("s2", 2), cena("s3", 4), cena("s4", 2)] }));
    state.set("legendasFaixa", { revision: 4, estado: "sem-fala", cues: [] });
    expect(faixa.querySelector(".seq-strip")).toBe(strip);
    expect(strip.isConnected).toBe(true);
    expect(faixa.querySelectorAll(".bloco-alca")).toHaveLength(3);

    ponteiro(a, "pointerup", 900);
    expect(faixa.querySelector(".seq-strip")).toBe(strip); // aguardando a resposta
    await concluir();
    medir();
    expect(faixa.querySelector(".seq-strip")).not.toBe(strip);
    expect(strip.isConnected).toBe(false);
    expect(faixa.querySelectorAll(".bloco-alca")).toHaveLength(4);
    expect(faixa.classList.contains("reordenando")).toBe(false);
  });

  it("gesto cancelado também redesenha com o projeto de então", async () => {
    const { alca, ponteiro, state, faixa, esc } = await monta();
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 900);
    state.set("project", projeto({ revision: 5 }, [cena("s1", 4), cena("s2", 2)]));
    expect(faixa.querySelectorAll(".bloco-alca")).toHaveLength(3);
    esc();
    expect(faixa.querySelectorAll(".bloco-alca")).toHaveLength(2);
  });

  it("segundo gesto só começa depois do fim do primeiro (um pedido em voo)", async () => {
    const { alca, ponteiro, edits, concluir } = await monta();
    ponteiro(alca("s1"), "pointerdown", 100);
    ponteiro(alca("s1"), "pointermove", 900);
    ponteiro(alca("s1"), "pointerup", 900);
    ponteiro(alca("s3"), "pointerdown", 900);
    ponteiro(alca("s3"), "pointermove", 10);
    ponteiro(alca("s3"), "pointerup", 10);
    expect(edits()).toHaveLength(1);
    await concluir();
  });

  it("Ctrl+Z e Ctrl+Y no meio do gesto não chamam project/undo nem project/redo", async () => {
    const proj = projeto({ undo: { head: 3, steps: [{ revision: 2, label: "Tirar trecho" }], redo: [{ revision: 9, label: "Outra" }] } });
    const controle = await monta({ project: proj, undoRevision: 2 });
    // controle: fora do gesto, Ctrl+Z desfaz
    controle.document.dispatchEvent({ type: "keydown", key: "z", ctrlKey: true, target: controle.document.body } as never);
    expect(controle.pedidos.map((p) => p.path)).toEqual(["project/undo"]);
    vi.resetModules();
    vi.unstubAllGlobals();

    const m = await monta({ project: proj, undoRevision: 2 });
    const a = m.alca("s1");
    m.ponteiro(a, "pointerdown", 100);
    m.ponteiro(a, "pointermove", 900);
    const z = { type: "keydown", key: "z", ctrlKey: true, target: m.document.body, defaultPrevented: false };
    m.document.dispatchEvent(z as never);
    m.document.dispatchEvent({ type: "keydown", key: "y", ctrlKey: true, target: m.document.body } as never);
    m.document.dispatchEvent({ type: "keydown", key: "Z", ctrlKey: true, shiftKey: true, target: m.document.body } as never);
    expect(m.pedidos).toEqual([]);
    m.esc();
    // com o gesto encerrado, o atalho volta
    m.document.dispatchEvent({ type: "keydown", key: "z", ctrlKey: true, target: m.document.body } as never);
    expect(m.pedidos.map((p) => p.path)).toEqual(["project/undo"]);
  });

  it("undo em voo antes de pegar: o arraste não pega e soltar não envia project/edit", async () => {
    const proj = projeto({ undo: { head: 3, steps: [{ revision: 2, label: "Tirar trecho" }] } });
    const { document, alca, ponteiro, pedidos, edits, faixa } = await monta({ project: proj, undoRevision: 2 });
    document.getElementById("undo")!.click();
    expect(pedidos.map((p) => p.path)).toEqual(["project/undo"]);
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 900);
    ponteiro(a, "pointerup", 900);
    expect(edits()).toHaveLength(0);
    expect(faixa.classList.contains("reordenando")).toBe(false);
  });

  it("undo disparado no meio do gesto: soltar não envia project/edit", async () => {
    const proj = projeto({ undo: { head: 3, steps: [{ revision: 2, label: "Tirar trecho" }] } });
    const { document, alca, ponteiro, pedidos, edits, faixa } = await monta({ project: proj, undoRevision: 2 });
    const a = alca("s1");
    ponteiro(a, "pointerdown", 100);
    ponteiro(a, "pointermove", 900);
    document.getElementById("undo")!.click();
    ponteiro(a, "pointerup", 900);
    expect(edits()).toHaveLength(0);
    expect(pedidos.map((p) => p.path)).toEqual(["project/undo"]);
    expect(faixa.classList.contains("reordenando")).toBe(false);
  });
});
