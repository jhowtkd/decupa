import { expect, it } from "vitest";
import { omittedWords, takeWords } from "./montage.js";
import { selectedFlags, selectedTake, selectionKey } from "./texto.js";

// selectedTake e selectedFlags só percorrem as cenas, os takes e as zonas
// que a seleção cita. Referência: as versões de antes, que varriam o projeto
// inteiro (cena × Mídia × palavra a cada seleção), copiadas aqui.

type Projeto = Parameters<typeof selectedTake>[0];

function refSelectedTake(project: Projeto, selection: Set<string> | null) {
  const groups = new Map();
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const prefix = scene.id + "\0" + take.id + "\0";
      const catalog = new Map(takeWords(project, scene, take).map((word: { id: string }) => [word.id, word]));
      const words = [];
      for (const key of selection || []) {
        if (!key.startsWith(prefix)) continue;
        const word = catalog.get(key.slice(prefix.length));
        if (word) words.push(word);
      }
      if (words.length) groups.set(scene.id + "\0" + take.id, { scene, take, sourceId: take.sourceId, words });
    }
    const bySource = new Map();
    for (const source of project.assembly.sources) {
      for (const word of omittedWords(project, scene, source.id)) {
        if (selection && selection.has(selectionKey(scene.id, "", word.id))) {
          if (!bySource.has(source.id)) bySource.set(source.id, []);
          bySource.get(source.id).push(word);
        }
      }
    }
    for (const [sourceId, words] of bySource) groups.set(scene.id + "\0\0" + sourceId, { scene, take: null, sourceId, words });
  }
  return groups.size === 1 ? groups.values().next().value : null;
}

function refSelectedFlags(project: Projeto, selection: Set<string>) {
  const flags = [];
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(project, scene, take)) {
        if (selection.has(selectionKey(scene.id, take.id, word.id))) {
          flags.push({ removed: !!word.removed, protected: !!word.protected, takeId: take.id });
        }
      }
    }
    for (const source of project.assembly.sources) {
      for (const word of omittedWords(project, scene, source.id)) {
        if (selection.has(selectionKey(scene.id, "", word.id))) flags.push({ removed: false, protected: false, takeId: "" });
      }
    }
  }
  return flags;
}

const palavras = (sourceId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${sourceId}:w${i}`, sourceId, text: `p${i}`, start: i, end: i + 0.8, confidence: 1 }));

/**
 * Duas Mídias; a Mídia `a` aparece em takes de cenas diferentes e em dois
 * takes da mesma cena; há corte, trecho preservado e zonas omitidas.
 */
function projeto(): Projeto {
  return {
    revision: 3, corrections: [], preparation: null, input: { text: "", targetSeconds: 60 },
    assembly: { fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "a", name: "a.mp4", included: true }, { id: "b", name: "b.mp4", included: true }] },
    analyses: [
      { sourceId: "a", words: palavras("a", 20), visual: [], speech: [], status: "ready" },
      { sourceId: "b", words: palavras("b", 6), visual: [], speech: [], status: "ready" },
    ],
    scenes: [
      { id: "c1", objective: "", support: [], gaps: [], takes: [
        { id: "t1", sourceId: "a", start: 0, end: 4, removed: [{ start: 1, end: 2 }], protected: [] },
        { id: "t2", sourceId: "a", start: 6, end: 8, removed: [], protected: [{ start: 6, end: 7 }] },
      ] },
      { id: "c2", objective: "", support: [], gaps: [], takes: [
        { id: "t3", sourceId: "b", start: 0, end: 3, removed: [], protected: [] },
        { id: "t4", sourceId: "a", start: 10, end: 12, removed: [{ start: 11, end: 12 }], protected: [] },
      ] },
      { id: "c3", objective: "", support: [], gaps: [], takes: [
        { id: "t5", sourceId: "a", start: 14, end: 16, removed: [], protected: [] },
      ] },
    ],
  } as unknown as Projeto;
}

/** Todas as chaves que o texto oferece: palavras dos takes e das zonas omitidas. */
function todasAsChaves(p: Projeto): string[] {
  const chaves: string[] = [];
  for (const scene of p.scenes) {
    for (const take of scene.takes) for (const word of takeWords(p, scene, take)) chaves.push(selectionKey(scene.id, take.id, word.id));
    for (const source of p.assembly.sources) for (const word of omittedWords(p, scene, source.id)) chaves.push(selectionKey(scene.id, "", word.id));
  }
  return chaves;
}

const k = selectionKey;
const CASOS: Record<string, string[]> = {
  vazia: [],
  mantidas: [k("c1", "t1", "a:w0"), k("c1", "t1", "a:w3")],
  cortadas: [k("c1", "t1", "a:w1")],
  "mantida e cortada": [k("c1", "t1", "a:w0"), k("c1", "t1", "a:w1")],
  preservadas: [k("c1", "t2", "a:w6")],
  "zona omitida": [k("c1", "", "a:w12"), k("c1", "", "a:w13")],
  "zona de outra Mídia": [k("c1", "", "b:w2")],
  "zona e take da mesma cena": [k("c1", "", "a:w12"), k("c1", "t1", "a:w0")],
  "dois takes da mesma cena": [k("c1", "t1", "a:w0"), k("c1", "t2", "a:w7")],
  "duas cenas": [k("c1", "t1", "a:w0"), k("c2", "t3", "b:w1")],
  "mesma palavra da Mídia em take e em zona": [k("c2", "t4", "a:w10"), k("c1", "", "a:w10")],
  "mesma palavra em duas zonas": [k("c1", "", "a:w15"), k("c2", "", "a:w15")],
  "chaves que não existem": [k("c9", "t1", "a:w0"), k("c1", "t9", "a:w0"), k("c1", "t1", "a:w99"), k("c1", "", "a:w0")],
};

it.each(Object.entries(CASOS))("selectedTake e selectedFlags: %s dá o mesmo que a varredura inteira", (_nome, chaves) => {
  const p = projeto();
  const selecao = new Set(chaves);
  expect(selectedTake(p, selecao)).toEqual(refSelectedTake(p, selecao));
  expect(selectedFlags(p, selecao)).toEqual(refSelectedFlags(p, selecao));
});

it("seleção nula: selectedTake segue devolvendo null", () => {
  expect(selectedTake(projeto(), null)).toBe(refSelectedTake(projeto(), null));
});

it("seleções aleatórias (semente fixa) dão o mesmo resultado que a varredura inteira", () => {
  const p = projeto();
  const chaves = todasAsChaves(p);
  let semente = 20261023;
  const aleatorio = () => (semente = (semente * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let rodada = 0; rodada < 300; rodada += 1) {
    const tamanho = 1 + Math.floor(aleatorio() * 6);
    const selecao = new Set(Array.from({ length: tamanho }, () => chaves[Math.floor(aleatorio() * chaves.length)]!));
    expect(selectedTake(p, selecao)).toEqual(refSelectedTake(p, selecao));
    expect(selectedFlags(p, selecao)).toEqual(refSelectedFlags(p, selecao));
  }
});

/** 20 Mídias × 2 000 palavras em 200 cenas, como o projeto extenso do e2e. */
function extenso(): Projeto {
  const sources = [];
  const analyses = [];
  const scenes = [];
  for (let m = 0; m < 20; m += 1) {
    sources.push({ id: `m${m}`, name: `m${m}.m4a`, included: true });
    analyses.push({ sourceId: `m${m}`, words: palavras(`m${m}`, 2000), visual: [], speech: [], status: "ready" });
    for (let f = 0; f < 10; f += 1) {
      scenes.push({ id: `c${m * 10 + f}`, objective: "", support: [], gaps: [],
        takes: [{ id: `t${m * 10 + f}`, sourceId: `m${m}`, start: f * 200, end: f * 200 + 199, removed: [], protected: [] }] });
    }
  }
  return { revision: 1, corrections: [], preparation: null, input: { text: "", targetSeconds: 60 },
    assembly: { fps: { num: 25, den: 1 }, width: 320, height: 240, sources }, analyses, scenes } as unknown as Projeto;
}

it("no projeto extenso, selecionar uma palavra não varre as outras cenas", () => {
  const p = extenso();
  const selecao = new Set([k("c0", "t0", "m0:w3")]);
  // Aquece os caches de catálogo do take citado; o que importa é a seleção nova.
  selectedTake(p, selecao);
  const t0 = performance.now();
  for (let i = 0; i < 10; i += 1) {
    const outra = new Set([k("c0", "t0", `m0:w${i}`)]);
    selectedTake(p, outra);
    selectedFlags(p, outra);
  }
  // A varredura inteira levava segundos por seleção neste tamanho.
  expect(performance.now() - t0).toBeLessThan(500);
  expect(selectedFlags(p, selecao)).toEqual([{ removed: false, protected: false, takeId: "t0" }]);
});
