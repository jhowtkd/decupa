import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import {
  applyHistorySnapshot, applyProposal, approveFinal, recordPreview,
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
