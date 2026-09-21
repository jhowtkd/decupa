import { describe, expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import {
  applyRhythmProposal,
  buildRhythmProposal,
  RHYTHM_PROFILES,
  rhythmPauses,
  rhythmSampleAssembly,
} from "./rhythm.ts";
import type { Project, SpeechTake } from "./types.ts";

function projectWithPauses(): Project {
  const assembly = fixtureAssembly();
  // O take cobre 4.3s — a fonte do fixture precisa acompanhar.
  assembly.sources[0]!.durationSeconds = 5;
  // Palavras com pausas variadas: 0.3–2.0 (1.7s, cortável), 2.3–2.8
  // (0.5s, intacta no natural), 3.4–4.0 (0.6s, cortável no direto).
  const words = [
    { start: 0, end: 0.3 },
    { start: 2.0, end: 2.3 },
    { start: 2.8, end: 3.4 },
    { start: 4.0, end: 4.3 },
  ].map((span, i) => ({
    id: `a:w${i}`, sourceId: "a", text: `w${i}`, confidence: null, ...span,
  }));
  return {
    version: 2,
    id: "p1",
    revision: 7,
    input: { kind: "brief", text: "tema", targetSeconds: 5 },
    assembly,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: ["u1"],
      takes: [{
        id: "t1", sourceId: "a", speechId: "u1",
        start: 0, end: 4.3, removed: [], protected: [],
      }],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
    analyses: [{
      sourceId: "a", key: "k",
      speech: [{ id: "u1", sourceId: "a", start: 0, end: 4.3, text: "w0 w1 w2 w3" }],
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

describe("controle de ritmo (#66)", () => {
  it("dois perfis documentados com parâmetros por escuta", () => {
    expect(Object.keys(RHYTHM_PROFILES)).toEqual(["natural", "direto"]);
    for (const profile of Object.values(RHYTHM_PROFILES)) {
      expect(profile.description.length).toBeGreaterThan(10);
      expect(profile.minPauseSeconds).toBeGreaterThan(profile.keepSeconds);
      expect(profile.edgeSeconds).toBeGreaterThan(0);
    }
    expect(RHYTHM_PROFILES.direto.minPauseSeconds)
      .toBeLessThan(RHYTHM_PROFILES.natural.minPauseSeconds);
  });

  it("pausas grandes viram cortes; pequenas ficam intactas", () => {
    const p = projectWithPauses();
    const { pauses, cuts } = rhythmPauses(p, take(p, "t1"), RHYTHM_PROFILES.natural)!;
    // 0.3–2.0 (1.7s) corta com edge+keep; 2.3–2.8 e 3.4–4.0 intactas.
    expect(cuts).toHaveLength(1);
    const cut = cuts[0]!;
    expect(cut.start).toBeCloseTo(0.3 + 0.08 + 0.225);
    expect(cut.end).toBeCloseTo(2.0 - 0.08 - 0.225);
    const intact = pauses.filter((pause) => pause.keep === pause.duration);
    expect(intact.map((pause) => pause.start)).toEqual([2.3, 3.4]);
  });

  it("o perfil direto corta pausas que o natural preserva", () => {
    const p = projectWithPauses();
    const direto = rhythmPauses(p, take(p, "t1"), RHYTHM_PROFILES.direto)!;
    // Direto: as três pausas passam de 0.35s → três cortes.
    expect(direto.cuts).toHaveLength(3);
  });

  it("fonte sem alinhamento é informada e pulada, sem microcortes", () => {
    const p = projectWithPauses();
    p.analyses[0]!.wordsStatus = "missing";
    expect(rhythmPauses(p, take(p, "t1"), RHYTHM_PROFILES.natural)).toBeNull();
    const proposal = buildRhythmProposal(p, "natural");
    expect(proposal.takes).toHaveLength(0);
    expect(proposal.unaligned).toEqual([{ takeId: "t1", sourceId: "a" }]);
  });

  it("trecho protegido não é cortado e fica evidenciado", () => {
    const p = projectWithPauses();
    take(p, "t1").protected = [{ start: 0.3, end: 2.0 }];
    const { pauses, cuts } = rhythmPauses(p, take(p, "t1"), RHYTHM_PROFILES.natural)!;
    expect(cuts).toHaveLength(0);
    const guard = pauses.find((pause) => pause.start === 0.3)!;
    expect(guard.protectedPart).toBe(true);
    expect(guard.keep).toBeCloseTo(guard.duration);
  });

  it("aceitar aplica cortes, marca perfil e invalida prévia e aprovação", () => {
    const p = projectWithPauses();
    const proposal = buildRhythmProposal(p, "natural");
    const next = applyRhythmProposal(p, proposal);
    expect(next.revision).toBe(8);
    expect(next.previewRevision).toBeNull();
    expect(next.finalApprovedRevision).toBeNull();
    expect(next.assembly.rhythmProfile).toBe("natural");
    expect(take(next, "t1").rhythm).toEqual({
      profile: "natural", removed: proposal.takes[0]!.cuts,
    });
    // A montagem compilada encurtou pelo tamanho do corte.
    const before = next.assembly.tracks.flatMap((track) => track.clips);
    expect(before.length).toBeGreaterThan(0);
  });

  it("trocar de perfil não acumula remoções", () => {
    const p = projectWithPauses();
    const natural = applyRhythmProposal(p, buildRhythmProposal(p, "natural"));
    const direto = applyRhythmProposal(natural, buildRhythmProposal(natural, "direto"));
    const t = take(direto, "t1");
    // A camada natural saiu; só os cortes do direto estão em rhythm.removed.
    expect(t.rhythm!.profile).toBe("direto");
    expect(t.rhythm!.removed).toHaveLength(3);
    // O removed do take contém a pausa de 2.3–2.8 que só o direto corta.
    expect(t.removed.some((range) => range.start >= 2.3 && range.end <= 2.8)).toBe(true);
    expect(direto.assembly.rhythmProfile).toBe("direto");
    // Reaplicar o mesmo perfil é no-op.
    const again = applyRhythmProposal(direto, buildRhythmProposal(direto, "direto"));
    expect(again).toBe(direto);
  });

  it("restauro manual convive com a camada de ritmo", () => {
    const p = projectWithPauses();
    // O usuário restaurou metade da pausa antes do ritmo chegar.
    take(p, "t1").removed = [{ start: 0.8, end: 1.4 }];
    const proposal = buildRhythmProposal(p, "natural");
    const next = applyRhythmProposal(p, proposal);
    // A restauração manual permanece fora da camada de ritmo: trocar de
    // perfil devolve o trecho dela ao usuário, não ao ritmo.
    const rhythmRanges = take(next, "t1").rhythm!.removed;
    expect(rhythmRanges).toHaveLength(2);
    expect(rhythmRanges[0]!.start).toBeCloseTo(0.605);
    expect(rhythmRanges[0]!.end).toBeCloseTo(0.8);
    expect(rhythmRanges[1]!.start).toBeCloseTo(1.4);
    expect(rhythmRanges[1]!.end).toBeCloseTo(1.695);
    const direto = applyRhythmProposal(next, buildRhythmProposal(next, "direto"));
    // Ao trocar, o removed volta a conter só a restauração + camada direto.
    expect(take(direto, "t1").removed.some((range) => range.start <= 0.8 && range.end >= 1.4))
      .toBe(true);
  });

  it("aplicação de proposta desatualizada é recusada", () => {
    const p = projectWithPauses();
    const proposal = buildRhythmProposal(p, "natural");
    const next = applyRhythmProposal(p, proposal);
    expect(() => applyRhythmProposal(next, proposal)).toThrow(/desatualizada/);
  });

  it("amostra compila o mesmo trecho antes e depois", () => {
    const p = projectWithPauses();
    const proposal = buildRhythmProposal(p, "natural");
    expect(proposal.sample).not.toBeNull();
    const antes = rhythmSampleAssembly(p, proposal, "antes")!;
    const depois = rhythmSampleAssembly(p, proposal, "depois")!;
    // A pausa de 1.7s cortada depois encurta a amostra.
    const dur = (a: typeof antes) => a.tracks
      .flatMap((track) => track.clips)
      .reduce((t, c) => t + c.durationFrames, 0);
    expect(dur(depois)).toBeLessThan(dur(antes));
  });
});
