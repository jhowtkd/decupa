// Trilha de legenda do studio com falas estreitas agrupadas: abaixo de
// LEGENDA_CUE_MIN_PX na largura e no zoom atuais, falas seguidas viram um
// bloco "N falas"; largas ficam sozinhas. Puro e no DOM.
import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { LEGENDA_CUE_MIN_PX, agruparCues, mountSequencia } from "./sequencia.js";
import { installDom } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cue = (start: number, end: number, text = `fala ${start}`) => ({ start, end, text });
/** `n` falas contíguas de `dur` s a partir de `inicio`. */
const seguidas = (n: number, dur: number, inicio = 0) => Array.from({ length: n }, (_, i) => cue(inicio + i * dur, inicio + (i + 1) * dur));
const grupo = (start: number, end: number, falas: number) => ({ start, end, falas });

it("o limiar é 24 px", () => {
  expect(LEGENDA_CUE_MIN_PX).toBe(24);
});

it("sem cues, nada a desenhar", () => {
  expect(agruparCues([], 10, 1000)).toEqual([]);
});

it("largura desconhecida (faixa escondida) ou montagem sem duração não agrupa", () => {
  const cues = seguidas(5, 0.01);
  expect(agruparCues(cues, 10, 0)).toBe(cues);
  expect(agruparCues(cues, 0, 1000)).toBe(cues);
});

it("limiar: 24 px fica sozinha; logo abaixo, agrupa com a vizinha", () => {
  // 10 s em 1000 px: 100 px por segundo.
  expect(agruparCues([cue(0, 0.24), cue(0.24, 0.48)], 10, 1000)).toEqual([cue(0, 0.24), cue(0.24, 0.48)]);
  expect(agruparCues([cue(0, 0.239), cue(0.239, 0.478)], 10, 1000)).toEqual([grupo(0, 0.478, 2)]);
});

it("zoom 1×/2×/4×/8×: as mesmas falas agrupam até ficarem largas o bastante", () => {
  // 40 falas de 0,5 s em 100 s; a trilha no 1× tem 1000 px (5 px por fala).
  const cues = seguidas(40, 0.5);
  const noZoom = (z: number) => agruparCues(cues, 100, 1000 * z);
  expect(noZoom(1)).toEqual([grupo(0, 20, 40)]);
  expect(noZoom(2)).toEqual([grupo(0, 20, 40)]);
  expect(noZoom(4)).toEqual([grupo(0, 20, 40)]);
  // No 8× cada fala tem 40 px: todas sozinhas, com o texto.
  expect(noZoom(8)).toEqual(cues);
});

it("largura: a mesma fala agrupa numa faixa estreita e fica sozinha numa larga", () => {
  const cues = seguidas(3, 0.5);
  expect(agruparCues(cues, 100, 1000)).toEqual([grupo(0, 1.5, 3)]);
  expect(agruparCues(cues, 100, 4800)).toEqual(cues);
});

it("fala larga isolada fica sozinha e separa os grupos em volta", () => {
  // 10 px por segundo: as curtas têm 2,5 px; a larga, 30 px.
  const cues = [...seguidas(3, 0.25), cue(0.75, 3.75, "larga"), ...seguidas(2, 0.25, 3.75)];
  expect(agruparCues(cues, 10, 100)).toEqual([grupo(0, 0.75, 3), cue(0.75, 3.75, "larga"), grupo(3.75, 4.25, 2)]);
});

it("sequência mista: grupo, estreita isolada depois de um vão, larga e outro grupo", () => {
  // 10 px por segundo; vão de 5 s (50 px) separa a estreita isolada.
  const cues = [
    cue(0, 0.5), cue(0.5, 1),
    cue(6, 6.5, "sozinha"),
    cue(7, 10, "larga"),
    cue(10.2, 10.6), cue(10.6, 11), cue(11, 11.4),
  ];
  expect(agruparCues(cues, 20, 200)).toEqual([
    grupo(0, 1, 2),
    cue(6, 6.5, "sozinha"),
    cue(7, 10, "larga"),
    grupo(10.2, 11.4, 3),
  ]);
});

it("vão de 24 px ou mais entre falas estreitas separa os grupos", () => {
  const cues = [cue(0, 0.1), cue(0.1, 0.2), cue(2.6, 2.7), cue(2.7, 2.8)];
  // 10 px por segundo: o vão de 2,4 s dá 24 px.
  expect(agruparCues(cues, 10, 100)).toEqual([grupo(0, 0.2, 2), grupo(2.6, 2.8, 2)]);
  // Com 2,3 s de vão (23 px), tudo num bloco só.
  expect(agruparCues([cue(0, 0.1), cue(0.1, 0.2), cue(2.5, 2.6)], 10, 100)).toEqual([grupo(0, 2.6, 3)]);
});

it("o bloco não atravessa o começo de uma cena: cada cena tem o seu", () => {
  // Falas contíguas de 0,5 s; cenas começam em 0, 2 e 3,5 s (10 px por segundo).
  const cues = seguidas(10, 0.5);
  expect(agruparCues(cues, 10, 100, [0, 2, 3.5])).toEqual([grupo(0, 2, 4), grupo(2, 3.5, 3), grupo(3.5, 5, 3)]);
  // Fala que começa antes do corte e termina depois fica com a cena em que começa.
  expect(agruparCues([cue(0, 0.5), cue(0.5, 2.2), cue(2.2, 2.6), cue(2.6, 3)], 10, 100, [0, 2]))
    .toEqual([grupo(0, 2.2, 2), grupo(2.2, 3, 2)]);
  // Uma fala estreita sozinha na cena dela segue sozinha.
  expect(agruparCues([cue(0, 0.5), cue(0.5, 1), cue(1, 1.5)], 10, 100, [0, 1])).toEqual([grupo(0, 1, 2), cue(1, 1.5)]);
});

function monta() {
  const document = installDom('<section id="faixa"></section><span id="undoSlot"></span>');
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) })));
  const state = createState({});
  state.set("project", {
    revision: 3, captions: [], corrections: [],
    scenes: [{ id: "s1", objective: "Cena s1", takes: [{ id: "t1", sourceId: "a", start: 0, end: 10, removed: [], protected: [] }], support: [], gaps: [] }],
    analyses: [{ sourceId: "a", words: [], visual: [] }],
    assembly: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, tracks: [],
      sources: [{ id: "a", name: "fala.mp4", hasVideo: true, hasAudio: true }] },
  });
  mountSequencia({ state, api: { call: vi.fn() }, player: { seek: vi.fn(), el: () => null }, ui: "studio" } as never);
  return { faixa: document.getElementById("faixa")!, state };
}

it("na faixa: com a largura conhecida, as falas estreitas viram um bloco 'N falas, m:ss–m:ss'", () => {
  const { faixa, state } = monta();
  const legendas = (cues: { startMs: number; endMs: number; text: string }[]) => ({ revision: 3, estado: "pronto", cues });
  const estreitas = Array.from({ length: 20 }, (_, i) => ({ startMs: i * 250, endMs: (i + 1) * 250, text: `curta ${i}` }));
  const todas = [...estreitas, { startMs: 6000, endMs: 9000, text: "fala larga" }];
  // Sem largura (fake DOM, ou faixa escondida): cada fala no seu bloco, como antes.
  state.set("legendasFaixa", legendas(todas));
  expect(faixa.querySelectorAll(".lane-legenda .seq-cue")).toHaveLength(21);
  expect(faixa.querySelectorAll(".lane-legenda .seq-cue-grupo")).toHaveLength(0);
  // 100 px para 10 s: cada curta tem 2,5 px; a larga, 30 px.
  const lane = faixa.querySelector(".lane-legenda")!;
  lane.clientWidth = 100;
  state.set("legendasFaixa", legendas(todas));
  const blocos = faixa.querySelectorAll(".lane-legenda .seq-cue");
  expect(blocos).toHaveLength(2);
  const bloco = faixa.querySelector(".lane-legenda .seq-cue-grupo")!;
  expect(bloco.getAttribute("title")).toBe("20 falas, 0:00–0:05");
  expect(bloco.getAttribute("aria-label")).toBe("20 falas, 0:00–0:05");
  expect(bloco.textContent).toBe("20 falas");
  expect(bloco.getAttribute("style")).toContain("left:0.000%;width:50.000%");
  const larga = blocos.find((el) => !el.className.includes("seq-cue-grupo"))!;
  expect(larga.getAttribute("title")).toBe("fala larga");
  expect(larga.textContent).toBe("fala larga");
});
