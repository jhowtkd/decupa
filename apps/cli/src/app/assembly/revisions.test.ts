import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import {
  applyEdit, applyHistorySnapshot, applyProposal, approveFinal, recordPreview,
} from "./revisions.ts";
import type { Project, Proposal } from "./types.ts";

function project(): Project {
  const assembly = fixtureAssembly();
  return {
    version: 2,
    id: "p1",
    revision: 2,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    previewRevision: 2,
    finalApprovedRevision: null,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

function proposalFor(p: Project): Proposal {
  return {
    id: "prop-1",
    baseRevision: p.revision,
    changedSceneIds: ["s1"],
    explanation: "reordenar",
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: [],
      takes: [],
      visualEvidenceIds: [],
      support: [],
      gaps: [],
    }],
  };
}

function projectWithTake(): Project {
  const base = project();
  const words = [0.1, 0.42, 0.72, 1.0].map((start, i) => ({
    id: `w${i + 1}`, sourceId: "a", text: `p${i + 1}`,
    confidence: null, start, end: start + 0.2,
  }));
  return {
    ...base,
    revision: 1,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u001"],
      takes: [{ id: "t1", sourceId: "a", speechId: "a:u001", start: 0, end: 2, removed: [], protected: [] }],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
    analyses: [{
      sourceId: "a", key: "k",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "fala" }],
      visual: [], status: "ready" as const, words, wordsStatus: "ready" as const,
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
  };
}

function twoSceneProject(): Project {
  const base = projectWithTake();
  const s2 = {
    id: "s2", objective: "fechar", rationale: "tema", speechIds: ["a:u001"],
    takes: [{ id: "t2", sourceId: "a", speechId: "a:u001", start: 0, end: 2, removed: [], protected: [] }],
    visualEvidenceIds: [], support: [], gaps: [],
  };
  return { ...base, scenes: [...base.scenes, s2] };
}

it("applyEdit recompila o assembly: remove encurta os clips da revisão nova", () => {
  const before = projectWithTake();
  const audioBefore = before.assembly.tracks.find((t) => t.kind === "Audio")!.clips;
  const after = applyEdit(before, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2"] });
  expect(after.revision).toBe(2);
  expect(after.assembly.revision).toBe(2);
  const audioAfter = after.assembly.tracks.find((t) => t.kind === "Audio")!.clips;
  const dur = (clips: { durationFrames: number }[]) => clips.reduce((n, c) => n + c.durationFrames, 0);
  expect(dur(audioAfter)).toBeLessThan(dur(audioBefore));
});

it("applyEdit de move-scene troca a ordem dos clips", () => {
  const p = twoSceneProject();
  const after = applyEdit(p, { type: "move-scene", sceneId: "s1", direction: "down" });
  const v1 = after.assembly.tracks.find((t) => t.kind === "Video")!.clips
    .slice().sort((a, b) => a.startFrame - b.startFrame);
  expect(v1[0]!.sceneId).toBe("s2");
});

it("recusa proposta obsoleta e prévia atrasada", () => {
  const p = project();
  const proposal = proposalFor(p);
  expect(() => applyProposal(p, { ...proposal, baseRevision: p.revision - 1 }))
    .toThrow(/revisão/);
  const artifact = {
    revision: p.revision,
    assemblySha256: "a".repeat(64),
    relativePath: "rev-2/reference.mp4",
    sha256: "b".repeat(64),
  };
  expect(() => recordPreview(p, { ...artifact, revision: p.revision - 1 })).toThrow(/outra revisão/);
  const previewed = recordPreview(p, artifact);
  expect(previewed.previewRevision).toBe(p.revision);
  expect(previewed.previewArtifact).toEqual(artifact);
  expect(() => approveFinal({ ...previewed, previewArtifact: null }, p.revision)).toThrow(/prévia/);
  expect(() => approveFinal(previewed, p.revision - 1)).toThrow(/assistida/);
  expect(approveFinal(previewed, p.revision).finalApprovedRevision).toBe(p.revision);
});

it("aplicar proposta incrementa revisão e invalida aprovações", () => {
  const p = project();
  const next = applyProposal(p, proposalFor(p));
  expect(next.revision).toBe(3);
  expect(next.assembly.revision).toBe(3);
  expect(next.previewRevision).toBeNull();
  expect(next.finalApprovedRevision).toBeNull();
});

it("undo restaura cena e correção como revisão nova sem tocar permissões", () => {
  const p = {
    ...project(),
    revision: 5,
    permissions: { model: true, visual: true },
    analyses: [{
      sourceId: "a",
      key: "k",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "olá tema" }],
      visual: [],
      status: "ready" as const,
      words: [],
      wordsStatus: "missing" as const,
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
  };
  const snap = {
    revision: 4,
    input: p.input,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u001"],
      takes: [{
        id: "t1", sourceId: "a", speechId: "a:u001",
        start: 0, end: 2, removed: [], protected: [],
      }],
      visualEvidenceIds: [],
      support: [], gaps: [],
    }],
    corrections: [],
    proposal: null,
  };
  const undone = applyHistorySnapshot(p, snap);
  expect(undone.revision).toBe(6);
  expect(undone.assembly.revision).toBe(6);
  expect(undone.scenes).toEqual(snap.scenes);
  expect(undone.permissions).toEqual({ model: true, visual: true });
  expect(undone.previewRevision).toBeNull();
  expect(undone.finalApprovedRevision).toBeNull();
});
