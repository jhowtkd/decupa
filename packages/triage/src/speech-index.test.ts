import { describe, expect, it } from "vitest";
import { looksLikeDeadAir, parseSpeechIndex, topicSpan, unitByIdOrThrow, unitsById } from "./speech-index.ts";

const raw = {
  source_duration: 245.5,
  budget: { lossless_floor_seconds: 120.179 },
  topic_runs: [
    { keyword: "instituição", unit_ids: ["u006", "u008"] },
    { keyword: "você", unit_ids: ["u003", "u009"] },
  ],
  trim_candidates: [
    {
      id: "u016",
      seconds: 2.588,
      text: "E cada um desse está em um nível completamente diferente",
      reasons: ["restates u015 (similarity 0.783)"],
    },
  ],
  units: [
    { id: "u003", index: 2, start: 3, end: 4, duration: 1, text: "três", has_terminal_punct: true, is_question: false },
    { id: "u006", index: 5, start: 6, end: 7.5, duration: 1.5, text: "seis", has_terminal_punct: true, is_question: false },
    { id: "u008", index: 7, start: 8, end: 9, duration: 1, text: "oito", has_terminal_punct: false, is_question: false },
    {
      id: "u009",
      index: 8,
      start: 9.5,
      end: 10,
      duration: 0.5,
      text: "nove",
      has_terminal_punct: true,
      is_question: true,
      near_duplicate_of: "u006",
      similarity: 0.881,
      word_count: 7,
      cps: 12.03,
      lead_gap: 2.278,
      disfluency: { hard: ["ahn"], soft: [], stutter: [] },
    },
  ],
};

describe("parseSpeechIndex", () => {
  it("lê unidades e topic_runs", () => {
    const index = parseSpeechIndex(raw);
    expect(index.units).toHaveLength(4);
    expect(index.topicRuns).toHaveLength(2);
    expect(index.losslessFloorSeconds).toBeCloseTo(120.179, 6);
  });

  it("ordena as unidades por index mesmo se vierem fora de ordem", () => {
    const shuffled = { ...raw, units: [raw.units[2], raw.units[0], raw.units[3], raw.units[1]] };
    expect(parseSpeechIndex(shuffled).units.map((u) => u.id))
      .toEqual(["u003", "u006", "u008", "u009"]);
  });

  it("recusa JSON sem units em vez de devolver índice vazio", () => {
    expect(() => parseSpeechIndex({ topic_runs: [] })).toThrow(/units/);
  });

  it("recusa start que não é número, nomeando o campo", () => {
    const clone = JSON.parse(JSON.stringify(raw)); // clone do fixture: JSON.parse/JSON.stringify
    clone.units[0].start = "abc";
    expect(() => parseSpeechIndex(clone)).toThrow(/start.*abc/);
  });

  it("lê near_duplicate_of, similaridade, contagem, cps, lead_gap e disfluency", () => {
    const u009 = parseSpeechIndex(raw).units.find((u) => u.id === "u009")!;
    expect(u009.nearDuplicateOf).toBe("u006");
    expect(u009.similarity).toBeCloseTo(0.881, 3);
    expect(u009.wordCount).toBe(7);
    expect(u009.cps).toBeCloseTo(12.03, 2);
    expect(u009.leadGap).toBeCloseTo(2.278, 3);
    expect(u009.disfluency).toEqual({ hard: ["ahn"], soft: [], stutter: [] });
  });

  it("lê trim_candidates com id, segundos, texto e reasons", () => {
    expect(parseSpeechIndex(raw).trimCandidates).toEqual([
      {
        id: "u016",
        seconds: 2.588,
        text: "E cada um desse está em um nível completamente diferente",
        reasons: ["restates u015 (similarity 0.783)"],
      },
    ]);
  });

  it("preenche campos ausentes com default (nearDuplicateOf null, trimCandidates [])", () => {
    const index = parseSpeechIndex(raw);
    const u003 = index.units.find((u) => u.id === "u003")!;
    expect(u003.nearDuplicateOf).toBeNull();
    expect(u003.similarity).toBeNull();
    expect(u003.wordCount).toBe(0);
    expect(u003.cps).toBe(0);
    expect(u003.leadGap).toBe(0);
    expect(u003.disfluency).toEqual({ hard: [], soft: [], stutter: [] });
    expect(parseSpeechIndex({ ...raw, trim_candidates: undefined }).trimCandidates).toEqual([]);
  });
});

describe("looksLikeDeadAir", () => {
  it("é false em restates (similarity), mesmo com número no texto", () => {
    expect(looksLikeDeadAir(["restates u015 (similarity 0.783)"])).toBe(false);
  });

  it("é true em very slow / dead air, mesmo com chars/s no meio", () => {
    expect(looksLikeDeadAir(["very slow (1.1 chars/s) — dead air inside the sentence"])).toBe(true);
  });

  it("é true em almost no content", () => {
    expect(looksLikeDeadAir(["almost no content for its length"])).toBe(true);
  });

  it("não trata chars/s sozinho como ar morto", () => {
    expect(looksLikeDeadAir(["cps 12.0 chars/s"])).toBe(false);
  });
});

describe("topicSpan", () => {
  it("devolve o menor e o maior index citados por qualquer topic_run", () => {
    // u003 (index 2) é o menor; u009 (index 8) é o maior
    expect(topicSpan(parseSpeechIndex(raw))).toEqual({ first: 2, last: 8 });
  });

  it("devolve null quando não há topic_run nenhum", () => {
    expect(topicSpan(parseSpeechIndex({ ...raw, topic_runs: [] }))).toBeNull();
  });
});

describe("unitByIdOrThrow", () => {
  it("acha a unidade", () => {
    expect(unitByIdOrThrow(parseSpeechIndex(raw), "u006").text).toBe("seis");
  });

  it("estoura com o id no texto do erro quando o modelo inventa um", () => {
    expect(() => unitByIdOrThrow(parseSpeechIndex(raw), "u999")).toThrow(/u999/);
  });
});

describe("unitsById", () => {
  it("unitsById devolve todas as unidades keyed por id", () => {
    const index = parseSpeechIndex(raw);
    const byId = unitsById(index);
    expect(byId.size).toBe(index.units.length);
    // u003 é a primeira unidade do fixture (após a ordenação por `index`)
    expect(byId.get("u003")).toBe(index.units[0]);
  });
});
