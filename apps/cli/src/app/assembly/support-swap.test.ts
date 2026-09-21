import { describe, expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import {
  applySupportSwap,
  buildSupportSwapProposal,
} from "./support-swap.ts";
import { brollCandidates } from "./broll.ts";
import type { Project } from "./types.ts";

function projectWithSupport(): Project {
  const p: Project = {
    version: 2,
    id: "p1",
    revision: 4,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly: fixtureAssembly(),
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: ["u1"],
      takes: [{
        id: "t1", sourceId: "a", speechId: "u1",
        start: 0, end: 2, removed: [], protected: [],
      }],
      // 1s de apoio "b:v0" a partir do frame 25 da cena.
      support: [{ visualId: "b:v0", offsetFrames: 25, durationFrames: 25 }],
      visualEvidenceIds: ["b:v0"], gaps: [],
    }],
    analyses: [
      {
        sourceId: "a", key: "k",
        speech: [{ id: "u1", sourceId: "a", start: 0, end: 2, text: "fala" }],
        visual: [], status: "ready", words: [], wordsStatus: "missing",
        visualCoverage: { requested: [], returned: [], missing: [] },
      },
      {
        sourceId: "b", key: "k",
        speech: [], status: "ready", words: [], wordsStatus: "missing",
        visual: [
          { id: "b:v0", sourceId: "b", start: 0, end: 1, text: "apoio atual", confidence: "observed", tags: [] },
          { id: "b:v1", sourceId: "b", start: 1, end: 2, text: "público aplaudindo", confidence: "observed", tags: [] },
        ],
        visualCoverage: { requested: [], returned: [], missing: [] },
      },
      {
        sourceId: "c", key: "k",
        speech: [], status: "ready", words: [], wordsStatus: "missing",
        visual: [
          { id: "c:v0", sourceId: "c", start: 0, end: 1.5, text: "palco distante", confidence: "observed", tags: [] },
        ],
        visualCoverage: { requested: [], returned: [], missing: [] },
      },
    ],
    proposal: null,
    previewRevision: 4,
    finalApprovedRevision: 4,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
  p.assembly.sources.push({
    id: "c", path: "/tmp/decupa-fixture/extra.mp4",
    sha256: "c".repeat(64), durationSeconds: 3, hasVideo: true, hasAudio: false,
    fps: { num: 25, den: 1 }, width: 320, height: 240,
    role: "support", included: true, name: "extra.mp4",
  });
  return p;
}

describe("troca localizada de apoio (#65)", () => {
  it("candidato apresenta trecho de origem e evidência, sem inventar mídia", () => {
    const p = projectWithSupport();
    const proposal = buildSupportSwapProposal(p, { sceneId: "s1", supportIndex: 0 }, "troca");
    expect(proposal.current.visualId).toBe("b:v0");
    expect(proposal.current.evidence).toBe("apoio atual");
    expect(proposal.current.sourceId).toBe("b");
    // O candidato não reutiliza o trecho já aplicado nem evidência em uso.
    expect(proposal.candidates.every((c) => !c.visualIds.includes("b:v0"))).toBe(true);
    expect(proposal.candidates.length).toBeGreaterThan(0);
    for (const candidate of proposal.candidates) {
      expect(candidate.sourceId).not.toBe("a"); // fala nunca vira apoio
      expect(candidate.description.length).toBeGreaterThan(0);
      expect(candidate.end).toBeGreaterThan(candidate.start);
    }
    expect(proposal.gap).toBeNull();
  });

  it("sem candidato adequado preserva a montagem e explica a lacuna", () => {
    const p = projectWithSupport();
    // Exclui todas as fontes de apoio: não sobra candidato.
    for (const source of p.assembly.sources) {
      if (source.role === "support") source.included = false;
    }
    const proposal = buildSupportSwapProposal(p, { sceneId: "s1", supportIndex: 0 }, "troca");
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.gap).toMatch(/sem candidato elegível/);
    // E a montagem do projeto não foi tocada.
    expect(p.scenes[0]!.support).toHaveLength(1);
    expect(p.revision).toBe(4);
  });

  it("substituição mantém falas, cortes e demais apoios; impacto visível antes", () => {
    const p = projectWithSupport();
    take(p).removed = [{ start: 0.5, end: 0.7 }];
    const proposal = buildSupportSwapProposal(p, { sceneId: "s1", supportIndex: 0 }, "troca");
    const candidate = proposal.candidates.find((c) => c.sourceId === "c")!;
    const next = applySupportSwap(p, proposal, candidate.id);
    expect(next.revision).toBe(5);
    expect(next.finalApprovedRevision).toBeNull();
    const scene = next.scenes[0]!;
    // Take e corte intactos; apoio trocado pelos entries do candidato.
    expect(scene.takes).toEqual(p.scenes[0]!.takes);
    expect(scene.support[0]!.visualId).not.toBe("b:v0");
    expect(scene.support[0]!.offsetFrames).toBe(25);
    expect(scene.visualEvidenceIds).toContain("b:v0");
    expect(scene.visualEvidenceIds).toContain(candidate.visualIds[0]);
  });

  it("aceitar fora da proposta ou desatualizado é recusado", () => {
    const p = projectWithSupport();
    const proposal = buildSupportSwapProposal(p, { sceneId: "s1", supportIndex: 0 }, "troca");
    const other = brollCandidates(p).find((c) => c.visualIds.includes("b:v0"))!;
    expect(() => applySupportSwap(p, proposal, other.id)).toThrow(/fora da proposta/);
    const next = applySupportSwap(p, proposal, proposal.candidates[0]!.id);
    expect(() => applySupportSwap(next, proposal, proposal.candidates[0]!.id))
      .toThrow(/desatualizada/);
  });
});

function take(p: Project) {
  return p.scenes[0]!.takes[0]!;
}
