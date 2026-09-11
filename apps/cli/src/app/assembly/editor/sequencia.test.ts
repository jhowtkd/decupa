import { expect, it } from "vitest";
import { fixtureAssembly } from "../fixture.ts";
import type { Project, Word } from "../types.ts";
import { activeScene, blocksAt, seekFromRatio } from "./sequencia.js";

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
