import { expect, it } from "vitest";
import { fixtureAssembly } from "../fixture.ts";
import type { Project, Word } from "../types.ts";
import { effectiveWords as tsEffective, retainedRanges as tsRetained } from "../words.ts";
import {
  effectiveWords,
  montageDuration,
  montageTimeOfWord,
  retainedOfTake,
  timelineBlocks,
} from "./montage.js";

function word(id: string, text: string, start: number, end: number): Word {
  return { id, sourceId: "a", text, confidence: null, start, end };
}

// Builder autocontido, idêntico ao de words.test.ts.
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

it("paridade retainedOfTake ↔ retainedRanges (TS)", () => {
  const take = {
    id: "t1", sourceId: "a", speechId: null, start: 0, end: 2,
    removed: [{ start: 0.4, end: 0.8 }], protected: [],
  };
  expect(retainedOfTake(take)).toEqual(tsRetained(take));
});

it("paridade effectiveWords (TS)", () => {
  expect(effectiveWords(project(), "a").map((w) => w.id))
    .toEqual(tsEffective(project(), "a").map((w) => w.id));
});

it("montageTimeOfWord soma retidos anteriores", () => {
  const p = project();
  // Tudo antes de w3 removido: retido anterior a w3 é [0.7, 0.72].
  p.scenes[0]!.takes[0]!.removed = [{ start: 0, end: 0.7 }];
  const w3 = p.analyses[0]!.words[2]!;
  // t = 0 (retidos anteriores) + (0.72 - 0.7) = 0.02
  expect(montageTimeOfWord(p, "s1", "t1", w3)).toBeCloseTo(0.02, 5);
  expect(montageTimeOfWord(p, "s9", "t1", w3)).toBeNull();
});

it("timelineBlocks: cena + apoio com tempos de montagem", () => {
  // Projeto com 2 cenas; apoio em s2 com offsetFrames 12, durationFrames 50, fps 25/1.
  const p2 = project();
  p2.scenes.push({
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
  const blocks = timelineBlocks(p2);
  expect(blocks.map((b) => b.kind)).toEqual(["scene", "scene", "support"]);
  expect(blocks[0]).toMatchObject({ kind: "scene", sceneId: "s1", start: 0, end: 2 });
  expect(blocks[1]).toMatchObject({ kind: "scene", sceneId: "s2", start: 2, end: 4 });
  const support = blocks[2]!;
  // Apoio ancora no início da cena (2s de fala retida em s1) + offset 12/25.
  expect(support.start).toBeCloseTo(2 + 12 / 25, 5);
  expect(support.end - support.start).toBeCloseTo(2, 5); // 50 frames / 25 fps
  expect(montageDuration(p2)).toBeCloseTo(support.end, 5);
  expect(montageDuration(project())).toBeCloseTo(2, 5);
});
