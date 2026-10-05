import { expect, it } from "vitest";
import {
  effectiveWords,
  montageDuration,
  omittedWords,
  retainedDuration,
  retainedOfTake,
  takeWords,
  wordAtPlayhead,
} from "./montage.js";
import { docSignature, pruneSelection, selectionKey } from "./texto.js";

type Word = {
  id: string;
  text: string;
  start: number;
  end: number;
  removed?: boolean;
  cutStart?: number;
  cutEnd?: number;
  sourceId?: string;
};

function fonte(id: string, words: Word[], visual: unknown[] = []) {
  return { sourceId: id, words, visual, speech: [], status: "ready" };
}

function projeto(over: Record<string, unknown> = {}) {
  const words: Word[] = [
    { id: "a", text: "a", start: 0, end: 1, cutEnd: 2 },
    { id: "b", text: "b", start: 0.5, end: 1.5 },
    { id: "c", text: "c", start: 3, end: 4 },
    { id: "d", text: "fora", start: 8, end: 9 },
  ];
  return {
    revision: 1,
    previewRevision: null,
    corrections: [],
    preparation: null,
    input: { text: "", targetSeconds: 60 },
    assembly: {
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [{ id: "s0", name: "src", included: true }],
    },
    analyses: [fonte("s0", words)],
    scenes: [{
      id: "c0",
      objective: "cena",
      takes: [{
        id: "t0", sourceId: "s0", start: 0, end: 5,
        removed: [{ start: 3, end: 4 }],
        protected: [],
      }],
      support: [],
      gaps: [],
    }],
    ...over,
  };
}

function naiveTake(project: ReturnType<typeof projeto>, scene: { id: string }, take: { id: string; sourceId: string; start: number; end: number }) {
  return effectiveWords(project, take.sourceId).filter((word) =>
    word.start >= take.start && word.start <= take.end && word.end <= take.end);
}

function naiveOmitted(project: ReturnType<typeof projeto>, scene: { takes: Array<{ sourceId: string }> }, sourceId: string) {
  const ranges = scene.takes
    .filter((take) => take.sourceId === sourceId)
    .flatMap((take) => retainedOfTake(take));
  return effectiveWords(project, sourceId).filter((word) =>
    !ranges.some((range) => range.start < word.end && word.start < range.end));
}

function naivePlayhead(project: ReturnType<typeof projeto>, t: number) {
  if (typeof t !== "number" || !Number.isFinite(t) || !project) return null;
  const spans: Array<{ start: number; end: number; sceneId: string; takeId: string; wordId: string }> = [];
  let elapsed = 0;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const removed = [...(take.removed || [])].sort((a, b) => a.start - b.start);
      const words = naiveTake(project, scene, take);
      for (const word of words) {
        const hit = removed.some((range) => range.start < word.end && word.start < range.end);
        if (hit) continue;
        let offset = word.start - take.start;
        for (const range of removed) {
          if (range.end <= word.start) offset -= range.end - Math.max(range.start, take.start);
        }
        const start = Math.max(0, elapsed + Math.max(0, offset));
        const srcStart = word.cutStart ?? word.start;
        const srcEnd = word.cutEnd ?? word.end;
        spans.push({
          start,
          end: start + Math.max(0, srcEnd - srcStart),
          sceneId: scene.id,
          takeId: take.id,
          wordId: word.id,
        });
      }
      elapsed += retainedDuration(take);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    if (span.start <= t && t < span.end) return { sceneId: span.sceneId, takeId: span.takeId, wordId: span.wordId };
  }
  return null;
}

function naivePrune(project: ReturnType<typeof projeto>, selection: Set<string>) {
  const known = new Set<string>();
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of naiveTake(project, scene, take)) known.add(selectionKey(scene.id, take.id, word.id));
    }
    for (const source of project.assembly.sources) {
      for (const word of naiveOmitted(project, scene, source.id)) known.add(selectionKey(scene.id, "", word.id));
    }
  }
  return new Set([...selection].filter((key) => known.has(key)));
}

it("wordAtPlayhead, omittedWords e pruneSelection batem com a busca ingênua", () => {
  const p = projeto();
  const scene = p.scenes[0]!;
  const take = scene.takes[0]!;
  expect(takeWords(p, scene, take).map((word) => word.id)).toEqual(naiveTake(p, scene, take).map((word) => word.id));
  expect(omittedWords(p, scene, "s0").map((word) => word.id)).toEqual(naiveOmitted(p, scene, "s0").map((word) => word.id));
  const times = [0, 0.2, 0.6, 1.2, 1.6, 2, 3];
  expect(times.map((t) => wordAtPlayhead(p, t))).toEqual(times.map((t) => naivePlayhead(p, t)));
  const vazia = new Set<string>();
  expect([...pruneSelection(p, vazia)]).toEqual([]);
  const selection = new Set([
    selectionKey("c0", "t0", "a"),
    selectionKey("c0", "t0", "sumiu"),
    selectionKey("c0", "", "d"),
  ]);
  expect([...pruneSelection(p, selection)].sort()).toEqual([...naivePrune(p, selection)].sort());
});

function grade(nSources: number, wordsPer: number, nScenes: number) {
  const analyses = [];
  const sources = [];
  for (let k = 0; k < nSources; k += 1) {
    const words = [];
    for (let i = 0; i < wordsPer; i += 1) {
      words.push({ id: `s${k}:w${i}`, sourceId: "s" + k, text: "palavra", start: i * 0.4, end: i * 0.4 + 0.3, confidence: 1 });
    }
    analyses.push({ sourceId: "s" + k, words, visual: [], speech: [] });
    sources.push({ id: "s" + k, name: "src" + k, included: true });
  }
  const per = (wordsPer * 0.4) / (nScenes / nSources);
  const scenes = [];
  for (let s = 0; s < nScenes; s += 1) {
    const k = s % nSources;
    const j = Math.floor(s / nSources);
    const start = j * per;
    scenes.push({
      id: "c" + s,
      objective: "cena " + s,
      takes: [{
        id: "t" + s, sourceId: "s" + k, start, end: (j + 1) * per * 0.8,
        removed: [{ start: start + 1, end: start + 2 }], protected: [],
      }],
      support: [],
      gaps: [],
    });
  }
  return {
    revision: 7, scenes, analyses, corrections: [], preparation: null,
    input: { text: "", targetSeconds: 60 },
    assembly: { fps: { num: 25, den: 1 }, sources },
  };
}

it("uma atualização de projeto grande fica abaixo de 16 ms", () => {
  const base = grade(5, 3000, 100);
  const scene = base.scenes[42]!;
  const keys = takeWords(base, scene, scene.takes[0]!).slice(0, 20)
    .map((word) => selectionKey(scene.id, scene.takes[0]!.id, word.id));
  const selection = new Set(keys);
  const empty = new Set<string>();
  const once = () => {
    const p = JSON.parse(JSON.stringify(base)) as typeof base;
    const t0 = performance.now();
    pruneSelection(p, empty);
    pruneSelection(p, selection);
    docSignature(p);
    montageDuration(p);
    wordAtPlayhead(p, montageDuration(p) / 2);
    return performance.now() - t0;
  };
  once();
  const runs = Array.from({ length: 7 }, once).sort((a, b) => a - b);
  expect(runs[3]!).toBeLessThan(16);
});

// Referência ingênua e independente: o algoritmo antigo, escrito aqui, sem
// reusar nenhuma função de montage.js (nem effectiveWords).
type Range = { start: number; end: number };
type RefWord = { id: string; text: string; start: number; end: number; cutStart?: number; cutEnd?: number };
type RefTake = { id: string; sourceId: string; start: number; end: number; removed: Range[]; protected: Range[] };
type RefProject = {
  scenes: Array<{ id: string; takes: RefTake[] }>;
  analyses: Array<{ sourceId: string; words: RefWord[] }>;
  corrections: Array<{ sourceId: string; status: string; start: number; end: number; words: RefWord[] }>;
};

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

function refEffective(p: RefProject, sourceId: string): RefWord[] {
  let words = [...(p.analyses.find((a) => a.sourceId === sourceId)?.words ?? [])];
  for (const c of p.corrections) {
    if (c.sourceId !== sourceId || c.status !== "aligned" || c.words.length === 0) continue;
    words = words.filter((w) => !overlaps(w, c));
    words.push(...c.words);
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

function refMerge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

function refRetained(take: RefTake): Range[] {
  let current: Range[] = [{ start: take.start, end: take.end }];
  const cuts = refMerge(take.removed
    .map((r) => ({ start: Math.max(r.start, take.start), end: Math.min(r.end, take.end) }))
    .filter((r) => r.start < r.end));
  for (const cut of cuts) {
    const next: Range[] = [];
    for (const r of current) {
      if (cut.end <= r.start || cut.start >= r.end) { next.push(r); continue; }
      if (cut.start > r.start) next.push({ start: r.start, end: cut.start });
      if (cut.end < r.end) next.push({ start: cut.end, end: r.end });
    }
    current = next;
  }
  return current;
}

const refDuration = (take: RefTake) => refRetained(take).reduce((s, r) => s + (r.end - r.start), 0);

function refTakeWords(p: RefProject, take: RefTake) {
  return refEffective(p, take.sourceId)
    .filter((w) => w.start >= take.start && w.end <= take.end)
    .map((w) => ({
      id: w.id,
      removed: take.removed.some((r) => overlaps(r, w)),
      protected: take.protected.some((r) => overlaps(r, w)),
      corrected: w.id.includes(":c:"),
    }));
}

function refOmitted(p: RefProject, scene: { takes: RefTake[] }, sourceId: string) {
  const kept = scene.takes.filter((t) => t.sourceId === sourceId).flatMap(refRetained);
  return refEffective(p, sourceId).filter((w) => !kept.some((r) => overlaps(r, w))).map((w) => w.id);
}

function refPlayhead(p: RefProject, t: number) {
  let best: { sceneId: string; takeId: string; wordId: string } | null = null;
  let bestStart = -Infinity;
  let elapsed = 0;
  for (const scene of p.scenes) {
    for (const take of scene.takes) {
      const cuts = refMerge(take.removed);
      for (const w of refEffective(p, take.sourceId)) {
        if (w.start < take.start || w.end > take.end) continue;
        if (take.removed.some((r) => overlaps(r, w))) continue;
        let offset = w.start - take.start;
        for (const r of cuts) if (r.end <= w.start) offset -= r.end - Math.max(r.start, take.start);
        const start = Math.max(0, elapsed + Math.max(0, offset));
        const end = start + Math.max(0, (w.cutEnd ?? w.end) - (w.cutStart ?? w.start));
        if (t >= start && t < end && start >= bestStart) {
          best = { sceneId: scene.id, takeId: take.id, wordId: w.id };
          bestStart = start;
        }
      }
      elapsed += refDuration(take);
    }
  }
  return best;
}

function projetoComplexo() {
  const seq = (prefix: string, n: number, step: number, len: number): Word[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}:w${i}`, text: `${prefix}${i}`, start: i * step, end: i * step + len,
    }));
  const s0 = seq("s0", 15, 1, 0.8);
  const s1 = seq("s1", 10, 0.9, 0.7);
  s1[3] = { ...s1[3]!, cutStart: 2.7, cutEnd: 3.6 };
  return {
    revision: 3,
    previewRevision: null,
    preparation: null,
    input: { text: "", targetSeconds: 60 },
    assembly: {
      fps: { num: 25, den: 1 }, width: 320, height: 240,
      sources: [{ id: "s0", name: "a", included: true }, { id: "s1", name: "b", included: true }],
    },
    analyses: [fonte("s0", s0), fonte("s1", s1)],
    corrections: [
      { id: "k1", sourceId: "s0", status: "aligned", start: 1.5, end: 3.5, text: "novo",
        words: [
          { id: "s0:sha:c:k1:w000000", text: "novo", start: 1.6, end: 2.4 },
          { id: "s0:sha:c:k1:w000001", text: "texto", start: 2.6, end: 3.4 },
        ] },
      { id: "k2", sourceId: "s1", status: "pending", start: 4, end: 5, text: "ignorada",
        words: [{ id: "s1:sha:c:k2:w000000", text: "ignorada", start: 4.1, end: 4.9 }] },
    ],
    scenes: [
      { id: "c0", objective: "um", support: [], gaps: [], takes: [
        { id: "t0", sourceId: "s0", start: 0, end: 10, removed: [{ start: 4, end: 5.5 }], protected: [{ start: 8, end: 9 }] },
      ] },
      { id: "c1", objective: "dois", support: [], gaps: [], takes: [
        { id: "t1", sourceId: "s1", start: 0, end: 6, removed: [{ start: 2, end: 3 }], protected: [] },
      ] },
      { id: "c2", objective: "três", support: [], gaps: [], takes: [
        { id: "t2", sourceId: "s0", start: 10, end: 15, removed: [], protected: [] },
        { id: "t3", sourceId: "s1", start: 6, end: 9, removed: [{ start: 7, end: 7.4 }], protected: [] },
      ] },
    ],
  };
}

it("takeWords, omittedWords e wordAtPlayhead batem com a referência ingênua independente", () => {
  const p = projetoComplexo();
  const ref = p as unknown as RefProject;
  for (const scene of p.scenes) {
    for (const take of scene.takes) {
      const got = takeWords(p, scene, take).map((w) => ({ id: w.id, removed: w.removed, protected: w.protected, corrected: w.corrected }));
      expect(got, `takeWords ${take.id}`).toEqual(refTakeWords(ref, take));
    }
    for (const source of p.assembly.sources) {
      expect(omittedWords(p, scene, source.id).map((w) => w.id), `omitted ${scene.id}/${source.id}`)
        .toEqual(refOmitted(ref, scene, source.id));
    }
  }
  const total = p.scenes.flatMap((s) => s.takes).reduce((sum, t) => sum + refDuration(t), 0);
  const tempos: number[] = [];
  for (let t = -0.5; t <= total + 1; t += 0.05) tempos.push(Math.round(t * 100) / 100);
  const achados = tempos.filter((t) => refPlayhead(ref, t) !== null).length;
  expect(achados).toBeGreaterThan(20);
  expect(tempos.map((t) => wordAtPlayhead(p, t))).toEqual(tempos.map((t) => refPlayhead(ref, t)));
  // A correção alinhada entrou e a pendente não.
  expect(refTakeWords(ref, p.scenes[0]!.takes[0]!).some((w) => w.corrected)).toBe(true);
  expect(refTakeWords(ref, p.scenes[1]!.takes[0]!).some((w) => w.corrected)).toBe(false);
});
