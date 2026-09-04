import { describe, expect, it } from "vitest";
import { parseSpeechIndex, topicSpan, unitByIdOrThrow } from "./speech-index.ts";

const raw = {
  source_duration: 245.5,
  budget: { lossless_floor_seconds: 120.179 },
  topic_runs: [
    { keyword: "instituição", unit_ids: ["u006", "u008"] },
    { keyword: "você", unit_ids: ["u003", "u009"] },
  ],
  units: [
    { id: "u003", index: 2, start: 3, end: 4, duration: 1, text: "três", has_terminal_punct: true, is_question: false },
    { id: "u006", index: 5, start: 6, end: 7.5, duration: 1.5, text: "seis", has_terminal_punct: true, is_question: false },
    { id: "u008", index: 7, start: 8, end: 9, duration: 1, text: "oito", has_terminal_punct: false, is_question: false },
    { id: "u009", index: 8, start: 9.5, end: 10, duration: 0.5, text: "nove", has_terminal_punct: true, is_question: true },
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
