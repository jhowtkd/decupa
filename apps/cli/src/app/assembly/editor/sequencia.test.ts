import { expect, it } from "vitest";
import { fixtureAssembly } from "../fixture.ts";
import type { Project, Word } from "../types.ts";
import {
  activeScene,
  blocksAt,
  bucketizeSegments,
  planSceneWave,
  rulerTicks,
  seekFromRatio,
} from "./sequencia.js";

function word(id: string, text: string, start: number, end: number): Word {
  return { id, sourceId: "a", text, confidence: null, start, end };
}

// Builder idêntico ao de montage.test.ts.
function project(): Project {
  const assembly = fixtureAssembly();
  const words = [
    word("w1", "palavra um", 0.1, 0.4),
    word("w2", "palavra dois", 0.42, 0.7),
    word("w3", "e", 0.72, 0.8),
    word("w4", "fim", 1.0, 1.3),
  ];
  return {
    version: 2,
    id: "p1",
    revision: 1,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly,
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: ["a:u001"],
      takes: [{
        id: "t1", sourceId: "a", speechId: "a:u001",
        start: 0, end: 2, removed: [], protected: [],
      }],
      visualEvidenceIds: [],
      support: [],
      gaps: [],
    }],
    analyses: [{
      sourceId: "a",
      key: "k",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "palavras" }],
      visual: [],
      status: "ready",
      words,
      wordsStatus: "ready",
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
    proposal: null,
    previewRevision: null,
    finalApprovedRevision: null,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

// Duas cenas; apoio em s2 com offsetFrames 12, durationFrames 50, fps 25/1
// (mesma geometria do teste de timelineBlocks em montage.test.ts:
// s1 0–2s, s2 2–4s, apoio 2.48–4.48s, duração total 4.48s).
function twoScenes(): Project {
  const p = project();
  p.scenes.push({
    id: "s2",
    objective: "fechar",
    rationale: "tema",
    speechIds: [],
    takes: [{
      id: "t2", sourceId: "a", speechId: null,
      start: 0, end: 2, removed: [], protected: [],
    }],
    visualEvidenceIds: [],
    support: [{ visualId: "b", offsetFrames: 12, durationFrames: 50 }],
    gaps: [],
  });
  return p;
}

it("seekFromRatio mapeia ratio em segundos da montagem", () => {
  const p = twoScenes(); // duração 4.48s
  expect(seekFromRatio(p, 0)).toBeCloseTo(0, 5);
  expect(seekFromRatio(p, 0.5)).toBeCloseTo(2.24, 5);
  expect(seekFromRatio(p, 1)).toBeCloseTo(4.48, 5);
});

it("seekFromRatio prende ratio fora de [0,1]", () => {
  const p = twoScenes();
  expect(seekFromRatio(p, -0.5)).toBeCloseTo(0, 5);
  expect(seekFromRatio(p, 2)).toBeCloseTo(4.48, 5);
});

it("blocksAt devolve o bloco de cena sob o playhead", () => {
  const p = twoScenes();
  expect(blocksAt(p, 1)).toEqual({ sceneId: "s1", kind: "scene" });
  expect(blocksAt(p, 2.2)).toEqual({ sceneId: "s2", kind: "scene" });
});

it("blocksAt prefere o apoio quando o playhead está sobre ele", () => {
  const p = twoScenes();
  expect(blocksAt(p, 3)).toEqual({ sceneId: "s2", kind: "support" });
});

it("blocksAt devolve null fora da montagem", () => {
  const p = twoScenes();
  expect(blocksAt(p, -1)).toBeNull();
  expect(blocksAt(p, 4.48)).toBeNull();
  expect(blocksAt(p, 99)).toBeNull();
});

it("activeScene devolve a cena sob o playhead, ignorando a camada de apoio", () => {
  const p = twoScenes();
  expect(activeScene(p, 1)).toBe("s1");
  expect(activeScene(p, 3)).toBe("s2");
  expect(activeScene(p, 99)).toBeNull();
});

it("rulerTicks gera passos nice de 0 até a duração", () => {
  expect(rulerTicks(73.1, 6)).toEqual([0, 20, 40, 60]);
  expect(rulerTicks(95.4, 6)).toEqual([0, 20, 40, 60, 80]);
  expect(rulerTicks(9, 6)).toEqual([0, 2, 4, 6, 8]);
  expect(rulerTicks(0, 6)).toEqual([0]);
});

// ---- Passada de desenho da waveform (ticket #11) ----

type Seg = {
  sourceId: string;
  srcStart: number;
  srcEnd: number;
  montageStart: number;
  montageEnd: number;
};

type Peaks = {
  sampleRate: number;
  count: number;
  peaks: { min: number; max: number }[];
};

// Peaks determinísticos (sem Math.random): a mesma semente gera os mesmos buckets.
function fakePeaks(seed: number, n = 64): Peaks {
  const peaks: { min: number; max: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    const r = a - Math.floor(a);
    peaks.push({ min: -Math.floor(r * 20000), max: Math.floor(r * 32767) });
  }
  return { sampleRate: 8000, count: n * 320, peaks };
}

// Dois segmentos contíguos (fontes a, b) + vão + terceiro segmento (fonte a).
function waveSegments(): Seg[] {
  return [
    { sourceId: "a", srcStart: 0, srcEnd: 2, montageStart: 0, montageEnd: 2 },
    { sourceId: "b", srcStart: 5, srcEnd: 6, montageStart: 2, montageEnd: 3 },
    { sourceId: "a", srcStart: 10, srcEnd: 12, montageStart: 4, montageEnd: 6 },
  ];
}

function waveSources(): Map<string, Peaks | null> {
  return new Map([
    ["a", fakePeaks(1)],
    ["b", fakePeaks(2)],
  ]);
}

// Referência ingênua com a semântica do loop antigo (find por pixel, sem cache).
function naivePlan(
  inBlock: Seg[],
  bySource: Map<string, Peaks | null>,
  blockStart: number,
  sceneDur: number,
  width: number,
  height: number,
): { x: number; top: number; h: number }[] {
  const ops: { x: number; top: number; h: number }[] = [];
  if (!(width > 0) || !(height > 0) || inBlock.length === 0) return ops;
  for (let x = 0; x < width; x++) {
    const montageT = blockStart + ((x + 0.5) / width) * sceneDur;
    const seg = inBlock.find((s) => s.montageStart <= montageT && montageT < s.montageEnd);
    if (!seg) continue;
    const peaks = bySource.get(seg.sourceId);
    if (!peaks || !Number.isFinite(peaks.sampleRate) || peaks.sampleRate <= 0) continue;
    const span = seg.montageEnd - seg.montageStart;
    const frac = span > 0 ? (montageT - seg.montageStart) / span : 0;
    const srcT = seg.srcStart + frac * (seg.srcEnd - seg.srcStart);
    const perBucket = peaks.count / peaks.peaks.length;
    if (!(perBucket > 0)) continue;
    const bucket =
      peaks.peaks[
        Math.min(
          peaks.peaks.length - 1,
          Math.max(0, Math.floor((srcT * peaks.sampleRate) / perBucket)),
        )
      ];
    if (!bucket) continue;
    const yMax = height / 2 - (bucket.max / 32768) * (height / 2);
    const yMin = height / 2 - (bucket.min / 32768) * (height / 2);
    const top = Math.min(yMin, yMax);
    ops.push({ x, top, h: Math.max(1, Math.abs(yMax - yMin)) });
  }
  return ops;
}

it("bucketizeSegments equivale a busca por pixel em toda a largura", () => {
  const inBlock = waveSegments();
  for (const width of [1, 7, 64, 300]) {
    const buckets: (Seg | null)[] = bucketizeSegments(inBlock, 0, 6, width);
    expect(buckets).toHaveLength(width);
    for (let x = 0; x < width; x++) {
      const montageT = 0 + ((x + 0.5) / width) * 6;
      const expected =
        inBlock.find((s) => s.montageStart <= montageT && montageT < s.montageEnd) ?? null;
      expect(buckets[x]).toBe(expected);
    }
  }
});

it("bucketizeSegments devolve null no vao e fora dos segmentos", () => {
  const buckets: (Seg | null)[] = bucketizeSegments(waveSegments(), 0, 6, 600);
  // Vão 3–4s corresponde às colunas 300–399; há nulos e há segmentos.
  expect(buckets.slice(300, 400).every((b) => b === null)).toBe(true);
  expect(buckets.some(Boolean)).toBe(true);
  expect(bucketizeSegments([], 0, 6, 100)).toEqual([]);
  expect(bucketizeSegments(waveSegments(), 0, 6, 0)).toEqual([]);
});

it("planSceneWave e pixel-identico a passada ingenua", () => {
  const inBlock = waveSegments();
  let total = 0;
  for (const [width, height] of [[1, 28], [7, 10], [64, 28], [300, 28], [301, 45]]) {
    const got = planSceneWave(inBlock, waveSources(), 0, 6, width, height);
    total += got.length;
    expect(got).toEqual(naivePlan(inBlock, waveSources(), 0, 6, width, height));
  }
  // Não-vácuo: as larguras maiores cobrem segmentos (width 1 cai no vão 3-4s).
  expect(total).toBeGreaterThan(0);
});

it("planSceneWave ignora fontes invalidas como a passada ingenua", () => {
  const inBlock = waveSegments();
  const sources = new Map<string, Peaks | null>([
    ["a", null],
    ["b", { sampleRate: 0, count: 100, peaks: [{ min: 0, max: 10 }] }],
  ]);
  expect(planSceneWave(inBlock, sources, 0, 6, 120, 28)).toEqual(
    naivePlan(inBlock, sources, 0, 6, 120, 28),
  );
  expect(planSceneWave([], waveSources(), 0, 6, 120, 28)).toEqual([]);
  expect(planSceneWave(inBlock, waveSources(), 0, 6, 0, 28)).toEqual([]);
});

it("planSceneWave resolve cada fonte uma unica vez, fora do loop de pixels", () => {
  let gets = 0;
  const counting = new Map(waveSources());
  const origGet = counting.get.bind(counting);
  counting.get = ((key: string) => {
    gets++;
    return origGet(key);
  }) as typeof counting.get;
  const ops = planSceneWave(waveSegments(), counting, 0, 6, 300, 28);
  expect(ops.length).toBeGreaterThan(0);
  // 3 segmentos em 2 fontes, 300 colunas: o loop antigo chamaria get uma vez
  // por coluna coberta (~300); com cache, uma vez por fonte distinta.
  expect(gets).toBe(2);
});
