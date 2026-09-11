import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { compileScenes, proposeScenes, validateProposal } from "./scenes.ts";
import type { Project, Proposal } from "./types.ts";

function project(): Project {
  const assembly = fixtureAssembly();
  return {
    version: 1,
    id: "p1",
    revision: 1,
    input: { kind: "script", text: "abrir com o tema", targetSeconds: 2 },
    assembly,
    scenes: [],
    analyses: [{
      sourceId: "a",
      key: "k",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "olá tema" }],
      visual: [{
        id: "a:v0", sourceId: "a", start: 0, end: 1, text: "rosto",
        confidence: "observed", tags: [],
      }],
      status: "ready",
    }],
    proposal: null,
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

it("recusa fala com ID inexistente", () => {
  const p = project();
  const raw = {
    id: "p1", baseRevision: p.revision, changedSceneIds: ["s1"],
    explanation: "abertura",
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema",
      speechIds: ["inexistente"], support: [], gaps: [],
    }],
  };
  expect(() => validateProposal(raw, p)).toThrow(/referência/);
});

it("compila fala e apoio sem inventar texto", () => {
  const p = project();
  p.analyses[0]!.visual.push({
    id: "b:v0", sourceId: "b", start: 0, end: 1, text: "apoio",
    confidence: "observed", tags: [],
  });
  const proposal = validateProposal({
    id: "p1",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "abertura",
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: ["a:u001"],
      support: [{ visualId: "b:v0", offsetFrames: 25, durationFrames: 25 }],
      gaps: [],
    }],
  }, p);
  const compiled = compileScenes(p, proposal.scenes);
  expect(compiled.tracks).toHaveLength(3);
  expect(compiled.tracks[0]!.clips[0]!.sourceId).toBe("a");
  expect(compiled.tracks[2]!.clips[0]!.sourceId).toBe("a");
});

it("marca lacuna quando o trecho do roteiro não existe", () => {
  const p = project();
  const proposal = validateProposal({
    id: "p1",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "falta cobertura",
    scenes: [{
      id: "s1",
      objective: "fechar",
      rationale: "não há fala",
      speechIds: [],
      support: [],
      gaps: ["sem fala para o encerramento"],
    }],
  }, p);
  expect(proposal.scenes[0]!.gaps).toHaveLength(1);
  const compiled = compileScenes(p, proposal.scenes);
  expect(compiled.tracks.every((t) => t.clips.length === 0)).toBe(true);
});

it("proposta do modelo só entra por ID de fala existente", async () => {
  const p = project();
  const raw = {
    id: "p1",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "abertura",
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: ["a:u001"],
      support: [],
      gaps: [],
    }],
  };
  const proposal = await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async () => JSON.stringify(raw),
  });
  expect(proposal.scenes[0]!.speechIds).toEqual(["a:u001"]);
});

it.each([undefined, 999, "1"])("vincula metadados do modelo ao snapshot: %s", async (modelRevision) => {
  const p = project();
  const result = await proposeScenes(p, "abrir", new AbortController().signal, {
    send: async (content) => {
      expect(JSON.stringify(content)).toContain('changedSceneIds');
      p.revision = 9;
      return JSON.stringify({ id: "inventado", baseRevision: modelRevision,
        scenes: [{ id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u001"], support: [], gaps: [] }],
        changedSceneIds: ["s1"], explanation: "abertura" });
    },
  });
  expect(result.baseRevision).toBe(1);
  expect(result.id).not.toBe("inventado");
  expect(() => validateProposal(result, p)).toThrow(/revisão desatualizada/);
});

it("continua recusando referência inventada na resposta LLM", async () => {
  await expect(proposeScenes(project(), "abrir", new AbortController().signal, {
    send: async () => JSON.stringify({ scenes: [{ id: "s1", speechIds: ["fake"] }], changedSceneIds: ["s1"] }),
  })).rejects.toThrow(/referência de fala inexistente/);
});
