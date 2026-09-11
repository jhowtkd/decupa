import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import {
  applyProposal, approveFinal, approveStructure, recordPreview,
} from "./revisions.ts";
import type { Project, Proposal } from "./types.ts";

function project(): Project {
  const assembly = fixtureAssembly();
  return {
    version: 1,
    id: "p1",
    revision: 2,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    structureApprovedRevision: 2,
    previewRevision: 2,
    finalApprovedRevision: null,
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
  expect(recordPreview(p, p.revision - 1).previewRevision).toBe(p.previewRevision);
  expect(() => approveFinal({ ...p, previewRevision: null })).toThrow(/prévia/);
});

it("aplicar proposta incrementa revisão e invalida aprovações", () => {
  const p = project();
  const next = applyProposal(p, proposalFor(p));
  expect(next.revision).toBe(3);
  expect(next.assembly.revision).toBe(3);
  expect(next.structureApprovedRevision).toBeNull();
  expect(next.previewRevision).toBeNull();
  expect(next.finalApprovedRevision).toBeNull();
});
