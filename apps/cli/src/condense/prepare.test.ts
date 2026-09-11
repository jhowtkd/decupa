import { describe, expect, it } from "vitest";
import type { Transcript } from "@decupa/transcript";
import { toCondenseTranscript } from "./prepare.ts";

const transcript: Transcript = {
  language: "pt",
  tokens: [
    { id: "w_000000", text: "Eu", startMs: 100, endMs: 260, confidence: 0.9, sentenceIndex: 0 },
    { id: "w_000001", text: "acho", startMs: 260, endMs: 520, confidence: 0.8, sentenceIndex: 0 },
    { id: "w_000002", text: "Vamos", startMs: 1200, endMs: 1500, confidence: 0.95, sentenceIndex: 1 },
  ],
};

describe("toCondenseTranscript com silêncios (conserto de fim inflado)", () => {
  // silêncio detectado de 1000ms a 2000ms
  const silences = [{ startMs: 1000, endMs: 2000 }];

  it("encolhe a palavra cujo fim foi esticado pelo alinhador", () => {
    const inflated: Transcript = {
      language: "pt",
      tokens: [
        { id: "w_000000", text: "promessa", startMs: 0, endMs: 1500, confidence: 0.9, sentenceIndex: 0 },
      ],
    };
    const out = toCondenseTranscript(inflated, { silences });
    // som acaba em ~1000ms; sobra a folga de cauda, nada perto de 1500
    expect(out.segments[0]!.words[0]!.end).toBeLessThan(1.2);
    expect(out.segments[0]!.words[0]!.end).toBeGreaterThan(0.95);
  });

  it("puxa o fim do segmento junto com a última palavra", () => {
    const inflated: Transcript = {
      language: "pt",
      tokens: [
        { id: "w_000000", text: "a", startMs: 0, endMs: 200, confidence: 0.9, sentenceIndex: 0 },
        { id: "w_000001", text: "promessa", startMs: 210, endMs: 1500, confidence: 0.9, sentenceIndex: 0 },
      ],
    };
    const out = toCondenseTranscript(inflated, { silences });
    expect(out.segments[0]!.end).toBe(out.segments[0]!.words[1]!.end);
    expect(out.segments[0]!.end).toBeLessThan(1.2);
  });

  it("não mexe em palavra de duração normal", () => {
    const normal: Transcript = {
      language: "pt",
      tokens: [
        { id: "w_000000", text: "oi", startMs: 100, endMs: 400, confidence: 0.9, sentenceIndex: 0 },
      ],
    };
    const out = toCondenseTranscript(normal, { silences });
    expect(out.segments[0]!.words[0]!.end).toBeCloseTo(0.4, 6);
  });

  it("sem silêncios, não apara nada (comportamento anterior preservado)", () => {
    const inflated: Transcript = {
      language: "pt",
      tokens: [
        { id: "w_000000", text: "promessa", startMs: 0, endMs: 1500, confidence: 0.9, sentenceIndex: 0 },
      ],
    };
    expect(toCondenseTranscript(inflated).segments[0]!.words[0]!.end).toBeCloseTo(1.5, 6);
  });
});

describe("toCondenseTranscript", () => {
  it("agrupa tokens por sentenceIndex em segmentos", () => {
    const out = toCondenseTranscript(transcript);
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]!.text).toBe("Eu acho");
    expect(out.segments[1]!.text).toBe("Vamos");
  });

  it("converte ms para segundos em start/end do segmento e das palavras", () => {
    const out = toCondenseTranscript(transcript);
    expect(out.segments[0]!.start).toBeCloseTo(0.1, 6);
    expect(out.segments[0]!.end).toBeCloseTo(0.52, 6);
    expect(out.segments[0]!.words[0]).toEqual({
      text: "Eu", start: 0.1, end: 0.26, id: "w_000000", confidence: 0.9,
    });
  });

  it("preserva id e confiança dos tokens sem quebrar o formato antigo", () => {
    const out = toCondenseTranscript(transcript);
    expect(out.segments[0]!.words.map((w) => [w.id, w.confidence])).toEqual([
      ["w_000000", 0.9],
      ["w_000001", 0.8],
    ]);
    for (const segment of out.segments) {
      expect(segment.text).toBe(segment.words.map((w) => w.text).join(" "));
      for (const word of segment.words) {
        expect(word.text).toEqual(expect.any(String));
        expect(word.start).toEqual(expect.any(Number));
        expect(word.end).toEqual(expect.any(Number));
      }
    }
  });

  it("preserva a ordem das palavras dentro do segmento mesmo se os tokens vierem fora de ordem", () => {
    const shuffled: Transcript = {
      language: "pt",
      tokens: [transcript.tokens[1]!, transcript.tokens[0]!],
    };
    const out = toCondenseTranscript(shuffled);
    expect(out.segments[0]!.words.map((w) => w.text)).toEqual(["Eu", "acho"]);
  });

  it("devolve segments vazio para transcript sem tokens", () => {
    expect(toCondenseTranscript({ language: "pt", tokens: [] })).toEqual({ segments: [] });
  });
});
