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
    expect(out.segments[0]!.words[0]).toEqual({ text: "Eu", start: 0.1, end: 0.26 });
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
