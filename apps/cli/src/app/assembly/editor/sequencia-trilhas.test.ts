// A faixa do studio em trilhas: blocos proporcionais, zoom, estados escritos
// quando falta dado (miniatura, onda, áudio, apoio, fala) e a legacy intacta.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createState } from "./state.js";
import { ZOOMS, cuesDaFaixa, legendaVazia, mountSequencia, zoomValido } from "./sequencia.js";
import { installDom, type El } from "./fake-dom.test-helper.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cheio = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const esperar = async () => { for (let i = 0; i < 4; i++) await cheio(); };

type Fonte = { id: string; name: string; hasVideo: boolean; hasAudio: boolean };
const fontes: Fonte[] = [
  { id: "a", name: "fala.mp4", hasVideo: true, hasAudio: true },
  { id: "b", name: "so-audio.wav", hasVideo: false, hasAudio: true },
  { id: "c", name: "mudo.mp4", hasVideo: true, hasAudio: false },
];

const take = (id: string, sourceId: string, end: number) => ({ id, sourceId, start: 0, end, removed: [], protected: [] });
const cena = (id: string, sourceId: string, end: number, support: unknown[] = []) => ({
  id, objective: "Cena " + id, takes: [take("t" + id, sourceId, end)], support, gaps: [],
});

/** 10 s no total: s1 (a, 4 s) com um apoio de 1 s a 3 s, s2 (b, 2 s) e s3 (c, 4 s); 25 fps. */
function projeto(extra: Record<string, unknown> = {}) {
  return {
    revision: 3,
    scenes: [
      cena("s1", "a", 4, [{ visualId: "v1", offsetFrames: 25, durationFrames: 50 }]),
      cena("s2", "b", 2),
      cena("s3", "c", 4),
    ],
    captions: [],
    corrections: [],
    analyses: [
      { sourceId: "a", words: [], visual: [{ id: "v1", sourceId: "c", start: 0, end: 2, text: "plano de apoio" }] },
      { sourceId: "b", words: [], visual: [] },
      { sourceId: "c", words: [], visual: [] },
    ],
    assembly: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sources: fontes, tracks: [] },
    ...extra,
  };
}

const peaksReais = { sampleRate: 8000, count: 64 * 320, peaks: Array.from({ length: 64 }, () => ({ min: -100, max: 100 })) };

type Opcoes = { ui?: "studio" | "legacy"; project?: unknown; peaks?: Record<string, "real" | "204" | "erro">; zoom?: number; legendas?: unknown };

function monta(opcoes: Opcoes = {}) {
  const document = installDom('<section id="faixa"></section><span id="undoSlot"></span>');
  const pedidos: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    pedidos.push(String(url));
    const id = /waveform\/(\w+)/.exec(String(url))?.[1] ?? "";
    const modo = opcoes.peaks?.[id] ?? "204";
    if (modo === "erro") throw new Error("sem rede");
    return modo === "real"
      ? { ok: true, status: 200, json: async () => peaksReais }
      : { ok: true, status: 204, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const state = createState({});
  if (opcoes.zoom !== undefined) state.set("zoomSequencia", opcoes.zoom);
  if (opcoes.legendas !== undefined) state.set("legendasFaixa", opcoes.legendas);
  state.set("project", opcoes.project ?? projeto());
  const api = { call: vi.fn(async () => ({ res: { ok: true }, body: {} })) };
  const player = { seek: vi.fn(), el: () => null };
  if (opcoes.ui === undefined) mountSequencia({ state, api, player } as never);
  else mountSequencia({ state, api, player, ui: opcoes.ui } as never);
  const faixa = document.getElementById("faixa")!;
  return { document, faixa, state, fetchMock, pedidos, api };
}

/** left/width em % do atributo style do bloco. */
function pct(el: El) {
  const style = el.getAttribute("style") ?? "";
  const num = (prop: string) => Number(new RegExp("(?:^|;)" + prop + ":([\\d.]+)%").exec(style)?.[1]);
  return { left: num("left"), width: num("width") };
}

const proximo = (a: number, b: number) => expect(a).toBeCloseTo(b, 2);

it("ZOOMS, zoomValido, cuesDaFaixa e legendaVazia (puras)", () => {
  expect(ZOOMS).toEqual([1, 2, 4, 8]);
  expect(zoomValido(4)).toBe(4);
  for (const ruim of [0, 3, -1, "2", null, undefined, Number.NaN]) expect(zoomValido(ruim), String(ruim)).toBe(1);

  const p = { revision: 3 };
  const legendas = { revision: 3, estado: "pronto", cues: [{ startMs: 5000, endMs: 6000, text: "b" }, { startMs: 1000, endMs: 2500, text: "a" }] };
  expect(cuesDaFaixa(legendas, p)).toEqual([{ start: 1, end: 2.5, text: "a" }, { start: 5, end: 6, text: "b" }]);
  expect(cuesDaFaixa({ ...legendas, revision: 2 }, p)).toEqual([]);
  expect(cuesDaFaixa({ ...legendas, estado: "sem-fala" }, p)).toEqual([]);
  expect(cuesDaFaixa(null, p)).toEqual([]);

  expect(legendaVazia(null, p)).toBe("carregando legenda…");
  expect(legendaVazia({ revision: 2, estado: "pronto" }, p)).toBe("carregando legenda…");
  expect(legendaVazia({ revision: 3, estado: "carregando" }, p)).toBe("carregando legenda…");
  expect(legendaVazia({ revision: 3, estado: "sem-fala" }, p)).toBe("sem fala retida");
  expect(legendaVazia({ revision: 3, estado: "sem-revisao" }, p)).toBe("sem legenda");
});

it("studio: quatro trilhas sob a mesma faixa, com blocos proporcionais de cena, apoio, áudio e legenda", async () => {
  const { faixa } = monta({
    ui: "studio",
    peaks: { a: "real", b: "204" },
    legendas: {
      revision: 3, estado: "pronto",
      cues: [{ startMs: 1000, endMs: 3000, text: "primeiro" }, { startMs: 5000, endMs: 8000, text: "segundo" }],
    },
  });
  await esperar();
  for (const trilha of ["video", "apoio", "audio", "legenda"]) {
    expect(faixa.querySelectorAll(".seq-lane.lane-" + trilha), trilha).toHaveLength(1);
  }
  const duracao = 10;
  // Vídeo: cenas em % da duração.
  const cenas = faixa.querySelectorAll('.lane-video .seq-bloco[data-kind="scene"]');
  expect(cenas.map((el) => el.dataset.scene)).toEqual(["s1", "s2", "s3"]);
  const esperadoCena: Array<[number, number]> = [[0, 4], [4, 2], [6, 4]];
  cenas.forEach((el, i) => {
    const { left, width } = pct(el);
    proximo(left, (esperadoCena[i]![0] / duracao) * 100);
    proximo(width, (esperadoCena[i]![1] / duracao) * 100);
    expect(Number(el.dataset.start)).toBeCloseTo(esperadoCena[i]![0], 6);
    expect(Number(el.dataset.end)).toBeCloseTo(esperadoCena[i]![0] + esperadoCena[i]![1], 6);
  });
  // Apoio: 1 s a 3 s.
  const apoio = faixa.querySelectorAll(".lane-apoio .seq-bloco.seq-apoio");
  expect(apoio).toHaveLength(1);
  proximo(pct(apoio[0]!).left, 10);
  proximo(pct(apoio[0]!).width, 20);
  // Áudio: um bloco por cena, na mesma posição da cena.
  const audios = faixa.querySelectorAll(".lane-audio .seq-audio");
  expect(audios.map((el) => el.dataset.scene)).toEqual(["s1", "s2", "s3"]);
  audios.forEach((el, i) => {
    proximo(pct(el).left, pct(cenas[i]!).left);
    proximo(pct(el).width, pct(cenas[i]!).width);
  });
  // Legenda: 1–3 s e 5–8 s.
  const cues = faixa.querySelectorAll(".lane-legenda .seq-cue");
  expect(cues.map((el) => el.getAttribute("title"))).toEqual(["primeiro", "segundo"]);
  proximo(pct(cues[0]!).left, 10);
  proximo(pct(cues[0]!).width, 20);
  proximo(pct(cues[1]!).left, 50);
  proximo(pct(cues[1]!).width, 30);
});

it("zoom: muda a largura de .faixa-trilhas sem mexer nas porcentagens e vai para o estado", async () => {
  const { faixa, state } = monta({ ui: "studio", peaks: { a: "real" } });
  await esperar();
  const trilhas = () => faixa.querySelector(".faixa-trilhas")!;
  expect(trilhas().style.width).toBe("100%");
  const antes = faixa.querySelectorAll(".lane-video .seq-bloco").map((el) => el.getAttribute("style"));
  const menos = () => faixa.querySelector('[data-zoom="-1"]')!;
  const mais = () => faixa.querySelector('[data-zoom="1"]')!;
  expect(menos().disabled).toBe(true);
  expect(mais().disabled).toBe(false);

  mais().dispatchEvent({ type: "click" });
  expect(state.get("zoomSequencia")).toBe(2);
  expect(trilhas().style.width).toBe("200%");
  mais().dispatchEvent({ type: "click" });
  expect(state.get("zoomSequencia")).toBe(4);
  expect(trilhas().style.width).toBe("400%");
  expect(faixa.querySelectorAll(".lane-video .seq-bloco").map((el) => el.getAttribute("style"))).toEqual(antes);
  expect(faixa.querySelector(".zoom-valor")!.textContent).toBe("4×");
  expect(menos().disabled).toBe(false);

  mais().dispatchEvent({ type: "click" });
  expect(state.get("zoomSequencia")).toBe(8);
  expect(mais().disabled).toBe(true);
  mais().dispatchEvent({ type: "click" });
  expect(state.get("zoomSequencia")).toBe(8);
  menos().dispatchEvent({ type: "click" });
  expect(state.get("zoomSequencia")).toBe(4);
  expect(trilhas().style.width).toBe("400%");
});

it("zoom guardado entra na faixa; valor inválido no estado vale 1×", async () => {
  expect(monta({ ui: "studio", zoom: 4 }).faixa.querySelector(".faixa-trilhas")!.style.width).toBe("400%");
  expect(monta({ ui: "studio", zoom: 3 }).faixa.querySelector(".faixa-trilhas")!.style.width).toBe("100%");
});

it("sem miniatura, sem apoio, sem áudio e sem onda são estados escritos", async () => {
  const { faixa, document } = monta({ ui: "studio", peaks: { a: "real", b: "204" } });
  await esperar();
  const [v1, v2, v3] = faixa.querySelectorAll(".lane-video .seq-bloco");
  // Fonte com vídeo: imagem real e nenhum aviso.
  expect(v1!.querySelector("img.timeline-thumb")).not.toBeNull();
  expect(v1!.querySelector(".sem-dado")).toBeNull();
  // Fonte só de áudio: sem miniatura.
  expect(v2!.querySelector("img")).toBeNull();
  expect(v2!.querySelector(".sem-dado")!.textContent).toBe("sem miniatura");
  expect(v3!.querySelector("img.timeline-thumb")).not.toBeNull();

  // O erro da imagem troca por "sem miniatura".
  const img = v1!.querySelector("img.timeline-thumb")!;
  img.dispatchEvent({ type: "error" });
  expect(v1!.querySelector("img")).toBeNull();
  expect(v1!.querySelector(".sem-dado")!.textContent).toBe("sem miniatura");
  expect(img.isConnected).toBe(false);

  // Áudio: s1 com onda real (escondido), s2 com 204 (visível), s3 sem áudio na fonte.
  const [a1, a2, a3] = faixa.querySelectorAll(".lane-audio .seq-audio");
  expect(a1!.querySelector(".sem-dado")!.hidden).toBe(true);
  expect(a1!.querySelector("canvas.seq-wave")!.hidden).toBe(false);
  expect(a2!.querySelector(".sem-dado")!.textContent).toBe("sem onda");
  expect(a2!.querySelector(".sem-dado")!.hidden).toBe(false);
  expect(a3!.querySelector("canvas")).toBeNull();
  expect(a3!.querySelector(".sem-dado")!.textContent).toBe("sem áudio");
  expect(a3!.querySelector(".sem-dado")!.hidden).toBe(false);

  // Sem apoio.
  const sem = monta({ ui: "studio", project: projeto({ scenes: [cena("s2", "b", 2)] }) });
  await esperar();
  expect(sem.faixa.querySelector(".lane-apoio .lane-vazia")!.textContent).toBe("sem apoio");
  expect(sem.faixa.querySelector(".lane-apoio .seq-bloco")).toBeNull();
  expect(document).toBeDefined();
});

it("erro de rede nos peaks também deixa 'sem onda' visível", async () => {
  const { faixa } = monta({ ui: "studio", peaks: { a: "erro" } });
  await esperar();
  const falta = faixa.querySelector('.seq-audio[data-scene="s1"] .sem-dado')!;
  expect(falta.textContent).toBe("sem onda");
  expect(falta.hidden).toBe(false);
});

it("a trilha de legenda diz por que está vazia: sem fala retida, sem legenda, carregando", async () => {
  const texto = async (legendas: unknown) => {
    const { faixa } = monta({ ui: "studio", legendas });
    await esperar();
    return faixa.querySelector(".lane-legenda .lane-vazia")!.textContent;
  };
  expect(await texto({ revision: 3, estado: "sem-fala", cues: [] })).toBe("sem fala retida");
  expect(await texto({ revision: 3, estado: "sem-revisao", cues: [] })).toBe("sem legenda");
  expect(await texto(undefined)).toBe("carregando legenda…");
  expect(await texto({ revision: 2, estado: "pronto", cues: [{ startMs: 0, endMs: 100, text: "velha" }] })).toBe("carregando legenda…");
});

it("legendasFaixa nova redesenha só a trilha de legenda com os cues dela", async () => {
  const { faixa, state } = monta({ ui: "studio" });
  await esperar();
  expect(faixa.querySelectorAll(".seq-cue")).toHaveLength(0);
  state.set("legendasFaixa", { revision: 3, estado: "pronto", cues: [{ startMs: 0, endMs: 2000, text: "olá" }] });
  const cue = faixa.querySelector(".lane-legenda .seq-cue")!;
  expect(cue.getAttribute("title")).toBe("olá");
  expect(cue.textContent).toBe("olá");
  proximo(pct(cue).width, 20);
});

it("o chip de formato mostra proporção, resolução e fps, e o botão Formato… existe só no studio", async () => {
  const { faixa } = monta({ ui: "studio" });
  expect(faixa.querySelector(".faixa-formato .mono")!.textContent).toBe("16:9 · 1920×1080 · 25 fps");
  expect(faixa.querySelector('[data-acao="formato"]')).not.toBeNull();
});

it("legacy (sem ui ou 'legacy'): DOM de antes, sem trilhas, zoom, sem-dado nem fetch de legenda", async () => {
  const comCaptions = projeto({ captions: [{ start: 1, end: 3, text: "da legacy" }] });
  for (const ui of [undefined, "legacy" as const]) {
    const { faixa, pedidos, state } = monta({ ui, project: comCaptions, peaks: { a: "real" }, legendas: { revision: 3, estado: "pronto", cues: [{ startMs: 0, endMs: 1000, text: "do studio" }] } });
    await esperar();
    expect(faixa.querySelectorAll(".seq-lane")).toHaveLength(0);
    expect(faixa.querySelector("[data-zoom]")).toBeNull();
    expect(faixa.querySelector("[data-acao]")).toBeNull();
    expect(faixa.querySelector(".sem-dado")).toBeNull();
    expect(faixa.querySelector(".faixa-trilhas")).toBeNull();
    expect(faixa.querySelector(".faixa-formato")).toBeNull();
    // Os blocos ficam direto no strip, como antes.
    const blocos = faixa.querySelectorAll(".seq-bloco");
    expect(blocos).toHaveLength(4);
    expect(blocos.every((el) => el.parentElement?.className === "seq-strip")).toBe(true);
    // As legendas vêm de project.captions, não do estado do studio.
    expect(faixa.querySelectorAll(".seq-captions .seq-cue").map((el) => el.textContent)).toEqual(["da legacy"]);
    expect(pedidos.filter((url) => url.includes("subtitles"))).toEqual([]);
    state.set("zoomSequencia", 4);
    state.set("legendasFaixa", { revision: 3, estado: "pronto", cues: [] });
    expect(faixa.querySelector(".faixa-trilhas")).toBeNull();
    expect(faixa.querySelectorAll(".seq-captions .seq-cue").map((el) => el.textContent)).toEqual(["da legacy"]);
  }
});

it("legacy: a assinatura não refaz o DOM quando só legendasFaixa ou zoom mudam", async () => {
  const { faixa, state } = monta({ ui: "legacy" });
  await esperar();
  const strip = faixa.querySelector(".seq-strip");
  state.set("legendasFaixa", { revision: 3, estado: "pronto", cues: [] });
  state.set("zoomSequencia", 8);
  expect(faixa.querySelector(".seq-strip")).toBe(strip);
});

it("page.html (legacy) não ganha #legendaMonitor; o studio.html tem", () => {
  const legacy = readFileSync(new URL("../page.html", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../studio.html", import.meta.url), "utf8");
  expect(legacy).not.toContain("legendaMonitor");
  expect(studio.match(/id="legendaMonitor"/g)).toHaveLength(1);
});
