import { describe, expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import {
  applySpeechProposal,
  buildSpeechProposal,
  speechScope,
} from "./speech-proposal.ts";
import type { Project, SpeechTake } from "./types.ts";

function projectWithSpeech(): Project {
  const assembly = fixtureAssembly();
  const words = ["oi", "é", "tipo", "tema", "valeu"].map((text, i) => ({
    id: `a:w${i}`, sourceId: "a", text, confidence: null,
    start: i * 0.4, end: i * 0.4 + 0.3,
  }));
  return {
    version: 2,
    id: "p1",
    revision: 7,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: ["u1"],
      takes: [{
        id: "t1", sourceId: "a", speechId: "u1",
        start: 0, end: 2, removed: [], protected: [],
      }],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
    analyses: [{
      sourceId: "a", key: "k",
      speech: [{ id: "u1", sourceId: "a", start: 0, end: 2, text: "oi é tipo tema valeu" }],
      visual: [], status: "ready",
      words, wordsStatus: "ready",
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
    proposal: null,
    previewRevision: 7,
    finalApprovedRevision: 7,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

function take(p: Project, id: string): SpeechTake {
  return p.scenes.flatMap((scene) => scene.takes).find((item) => item.id === id)!;
}

describe("ajuste localizado de fala (#64)", () => {
  it("resolve o escopo: fala, takes na montagem e palavras do trecho", () => {
    const scope = speechScope(projectWithSpeech(), "a", "u1");
    expect(scope.speech.text).toBe("oi é tipo tema valeu");
    expect(scope.takes.map(({ take: t }) => t.id)).toEqual(["t1"]);
    expect(scope.words.map((w) => w.text)).toEqual(["oi", "é", "tipo", "tema", "valeu"]);
  });

  it("escopo inexistente é recusado sem mudar nada", () => {
    const p = projectWithSpeech();
    expect(() => speechScope(p, "a", "inexistente")).toThrow(/fala .* não encontrada/);
    expect(() => speechScope(p, "b", "u1")).toThrow(/sem análise/);
  });

  it("a comparação identifica cortes e o impacto de duração", () => {
    const p = projectWithSpeech();
    const proposal = buildSpeechProposal(p, { sourceId: "a", speechId: "u1" },
      "tira a muleta", [{ wordIds: ["a:w2"], reason: "preenchimento" }]);
    expect(proposal.cuts).toHaveLength(1);
    expect(proposal.cuts[0]!.reason).toBe("preenchimento");
    expect(proposal.before.text).toBe("oi é tipo tema valeu");
    expect(proposal.after.text).toBe("oi é tema valeu");
    expect(proposal.after.durationSeconds).toBeLessThan(proposal.before.durationSeconds);
    expect(proposal.changedTakeIds).toEqual(["t1"]);
  });

  it("corte com palavra de fora do escopo é recusado", () => {
    const p = projectWithSpeech();
    expect(() => buildSpeechProposal(p, { sourceId: "a", speechId: "u1" },
      "corta", [{ wordIds: ["b:w9"] }])).toThrow(/fora do escopo/);
    // A exceção pode misturar ids válidos e inválidos: a recusa é total.
    expect(() => buildSpeechProposal(p, { sourceId: "a", speechId: "u1" },
      "corta", [{ wordIds: ["a:w0", "a:w9"] }])).toThrow(/fora do escopo/);
  });

  it("trechos protegidos não são removidos pela proposta", () => {
    const p = projectWithSpeech();
    take(p, "t1").protected = [{ start: 0.7, end: 1.2 }];
    const proposal = buildSpeechProposal(p, { sourceId: "a", speechId: "u1" },
      "tira tudo", [
        { wordIds: ["a:w2"] }, // intervalo 0.7–1.2, inteiro protegido
        { wordIds: ["a:w1"], reason: "ok" },
      ]);
    expect(proposal.skippedProtected).toBe(1);
    expect(proposal.cuts).toHaveLength(2);
    const next = applySpeechProposal(p, proposal);
    expect(take(next, "t1").removed).toHaveLength(1);
    // O único corte aplicado não toca o intervalo protegido.
    expect(take(next, "t1").removed[0]!.end).toBeLessThanOrEqual(0.8);
  });

  it("aceitar gera revisão e invalida prévia e aprovação", () => {
    const p = projectWithSpeech();
    const proposal = buildSpeechProposal(p, { sourceId: "a", speechId: "u1" },
      "tira a muleta", [{ wordIds: ["a:w2"] }]);
    const next = applySpeechProposal(p, proposal);
    expect(next.revision).toBe(8);
    expect(next.previewRevision).toBeNull();
    expect(next.finalApprovedRevision).toBeNull();
    expect(take(next, "t1").removed).toHaveLength(1);
    // O resto do projeto permanece igual.
    expect(take(next, "t1").protected).toEqual([]);
    expect(next.analyses[0]!.words).toHaveLength(5);
  });

  it("aplicação de proposta desatualizada é recusada", () => {
    const p = projectWithSpeech();
    const proposal = buildSpeechProposal(p, { sourceId: "a", speechId: "u1" },
      "tira a muleta", [{ wordIds: ["a:w2"] }]);
    const next = applySpeechProposal(p, proposal);
    expect(() => applySpeechProposal(next, proposal)).toThrow(/desatualizada/);
  });
});
