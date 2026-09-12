import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import type { Project, SpeechTake, Word } from "./types.ts";
import {
  applyTextEdit,
  effectiveWords,
  parseEditAction,
  retainedRanges,
  settleCorrection,
  snapWordCuts,
} from "./words.ts";

function word(id: string, text: string, start: number, end: number): Word {
  return { id, sourceId: "a", text, confidence: null, start, end };
}

function project(): Project {
  const assembly = fixtureAssembly();
  const words = [
    word("w1", "Nilton", 0.1, 0.4),
    word("w2", "Pinto", 0.42, 0.7),
    word("w3", "e", 0.72, 0.8),
    word("w4", "Tom", 1.0, 1.3),
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
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "Nilton Pinto e Tom" }],
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

it("subtrai exclusão do take em intervalos semiabertos", () => {
  const take: SpeechTake = {
    id: "t1", sourceId: "a", speechId: "a:u001",
    start: 0, end: 2, removed: [{ start: 0.4, end: 0.8 }], protected: [],
  };
  expect(retainedRanges(take)).toEqual([
    { start: 0, end: 0.4 }, { start: 0.8, end: 2 },
  ]);
  expect(retainedRanges({ ...take, removed: [] })).toEqual([{ start: 0, end: 2 }]);
});

it("remove corta a mídia e restore devolve a seleção anterior", () => {
  const before = project();
  const removed = applyTextEdit(before, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2"] });
  expect(removed.revision).toBe(2);
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([
    { start: 0.1, end: 0.7 },
  ]);
  // Catálogo textual intacto: remover não destrói a transcrição.
  expect(removed.analyses[0]!.words).toEqual(before.analyses[0]!.words);
  const restored = applyTextEdit(removed, { type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2"] });
  expect(restored.scenes[0]!.takes[0]!.removed).toEqual([]);
  expect(retainedRanges(restored.scenes[0]!.takes[0]!)).toEqual([{ start: 0, end: 2 }]);
});

it("remove de palavras não contíguas preserva a palavra do meio", () => {
  const before = project();
  // w1: [0.1, 0.4], w3: [0.72, 0.8]. w2 [0.42, 0.7] fica no meio.
  const removed = applyTextEdit(before, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w3"] });
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([
    { start: 0.1, end: 0.4 },
    { start: 0.72, end: 0.8 },
  ]);
  const retained = retainedRanges(removed.scenes[0]!.takes[0]!);
  // Preserva [0, 0.1], o meio [0.4, 0.72] (que contém w2) e [0.8, 2]
  expect(retained).toEqual([
    { start: 0, end: 0.1 },
    { start: 0.4, end: 0.72 },
    { start: 0.8, end: 2 },
  ]);
});

it("correct não move a seleção de mídia", () => {
  const before = project();
  const next = applyTextEdit(before, {
    type: "correct", sourceId: "a", start: 0.1, end: 0.7, text: "Nilton Pinto",
  });
  expect(next.scenes).toEqual(before.scenes);
  expect(next.corrections).toHaveLength(1);
  expect(next.corrections[0]).toMatchObject({ sourceId: "a", start: 0.1, end: 0.7, status: "pending" });
  expect(next.revision).toBe(2);
});

it("correções sobrepostas viram um único intervalo pendente", () => {
  const first = applyTextEdit(project(), {
    type: "correct", sourceId: "a", start: 0.1, end: 0.5, text: "Nilton",
  });
  const second = applyTextEdit(first, {
    type: "correct", sourceId: "a", start: 0.4, end: 0.8, text: "Nilton Pinto e",
  });
  expect(second.corrections).toHaveLength(1);
  expect(second.corrections[0]).toMatchObject({ start: 0.1, end: 0.8, text: "Nilton Pinto e" });
});

it("remove rejeita id inexistente, outra fonte, fora do take e proteção", () => {
  const p = project();
  expect(() => applyTextEdit(p, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["zz"] }))
    .toThrow(/não encontrada/);
  const other: Project = {
    ...p,
    analyses: [...p.analyses, {
      sourceId: "b", key: "k2", speech: [], visual: [], status: "ready",
      words: [word("wb", "apoio", 0.1, 0.4)].map((w) => ({ ...w, sourceId: "b" })),
      wordsStatus: "ready",
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
  };
  expect(() => applyTextEdit(other, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["wb"] }))
    .toThrow(/outra fonte/);
  const outside: Project = {
    ...p,
    analyses: p.analyses.map((a) => a.sourceId !== "a" ? a : {
      ...a,
      words: [...a.words, word("w5", "fora", 2.5, 2.8)],
    }),
  };
  expect(() => applyTextEdit(outside, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w5"] }))
    .toThrow(/fora do take/);
  const guarded = applyTextEdit(p, { type: "protect", sceneId: "s1", takeId: "t1", wordIds: ["w1"] });
  expect(() => applyTextEdit(guarded, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"] }))
    .toThrow(/protegido/);
  const freed = applyTextEdit(guarded, { type: "unprotect", sceneId: "s1", takeId: "t1", wordIds: ["w1"] });
  expect(freed.scenes[0]!.takes[0]!.protected).toEqual([]);
});

it("include cria take para fala fora da seleção; rejeita trecho já retido", () => {
  const p = project();
  const reduced: Project = {
    ...p,
    scenes: p.scenes.map((s) => s.id !== "s1" ? s : {
      ...s,
      takes: [{ id: "t1", sourceId: "a", speechId: "a:u001", start: 0, end: 0.9, removed: [], protected: [] }],
    }),
  };
  const next = applyTextEdit(reduced, { type: "include", sceneId: "s1", sourceId: "a", wordIds: ["w4"] });
  expect(next.scenes[0]!.takes).toHaveLength(2);
  expect(next.scenes[0]!.takes[1]).toMatchObject({ sourceId: "a", start: 1.0, end: 1.3 });
  expect(() => applyTextEdit(p, { type: "include", sceneId: "s1", sourceId: "a", wordIds: ["w1"] }))
    .toThrow(/já está na montagem/);
});

it("move e exclui cenas preservando a ordem das demais", () => {
  const two: Project = {
    ...project(),
    scenes: [
      { ...project().scenes[0]!, id: "s1" },
      { ...project().scenes[0]!, id: "s2" },
    ],
  };
  const moved = applyTextEdit(two, { type: "move-scene", sceneId: "s2", direction: "up" });
  expect(moved.scenes.map((s) => s.id)).toEqual(["s2", "s1"]);
  expect(() => applyTextEdit(moved, { type: "move-scene", sceneId: "s2", direction: "up" }))
    .toThrow(/extremo/);
  const deleted = applyTextEdit(moved, { type: "delete-scene", sceneId: "s1" });
  expect(deleted.scenes.map((s) => s.id)).toEqual(["s2"]);
});

it("parseEditAction rejeita ação desconhecida e campos inválidos", () => {
  expect(() => parseEditAction({ type: "voar" })).toThrow(/desconhecida/);
  expect(() => parseEditAction({ type: "remove", sceneId: "s1", takeId: "t1", wordIds: [] }))
    .toThrow(/wordIds/);
  expect(() => parseEditAction({ type: "correct", sourceId: "a", start: 0, end: 1, text: "  " }))
    .toThrow(/texto vazio/);
  expect(parseEditAction({ type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"] }))
    .toEqual({ type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"] });
});

it("settleCorrection publica alinhamento sem tocar nos takes", () => {
  const pending = applyTextEdit(project(), {
    type: "correct", sourceId: "a", start: 0.1, end: 0.7, text: "Nilton Pinto",
  });
  const id = pending.corrections[0]!.id;
  const takesBefore = pending.scenes[0]!.takes;
  const aligned = settleCorrection(pending, id, {
    words: [
      { text: "Nilton", start: 0.1, end: 0.4, confidence: 0.9 },
      { text: "Pinto", start: 0.42, end: 0.7, confidence: 0.8 },
    ],
  });
  expect(aligned.revision).toBe(pending.revision);
  expect(aligned.scenes[0]!.takes).toEqual(takesBefore);
  expect(aligned.corrections[0]!.status).toBe("aligned");
  expect(effectiveWords(aligned, "a").slice(0, 2).map((w) => w.text)).toEqual(["Nilton", "Pinto"]);
  const failed = settleCorrection(pending, id, { error: "sem vínculo" });
  expect(failed.corrections[0]).toMatchObject({ status: "error", error: "sem vínculo" });
  expect(() => settleCorrection(aligned, id, { error: "x" })).toThrow(/já resolvida/);
});

it("effectiveWords mantém o original com correção pendente", () => {
  const pending = applyTextEdit(project(), {
    type: "correct", sourceId: "a", start: 0.1, end: 0.4, text: "NILTON",
  });
  expect(effectiveWords(pending, "a").map((w) => w.text).slice(0, 2)).toEqual(["Nilton", "Pinto"]);
});

it("snapWordCuts prende aos vizinhos e aproveita pausa anterior", () => {
  // 2s a 16kHz; hop padrão de 10ms.
  const flat = new Int16Array(32000).fill(10000);
  const cuts = snapWordCuts(flat, [{ start: 1.0, end: 1.5 }, { start: 1.6, end: 1.9 }]);
  expect(cuts[0]!.start).toBeCloseTo(1.0, 6);
  expect(cuts[0]!.end).toBeLessThanOrEqual(1.6);
  // Vale de silêncio em 0.9–1.0s: o corte do ataque recua para a pausa.
  const pcm = new Int16Array(32000).fill(10000);
  pcm.fill(0, 14400, 16000);
  const dipped = snapWordCuts(pcm, [{ start: 1.0, end: 1.5 }]);
  expect(dipped[0]!.start).toBeLessThan(1.0);
  expect(dipped[0]!.start).toBeGreaterThanOrEqual(0.9);
});
