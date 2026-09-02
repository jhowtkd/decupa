import { describe, expect, it } from "vitest";
import { toTokens, wordBoundaries, wordOnsets } from "./tokens.ts";

const words = [
  { text: "eu", startMs: 100, endMs: 260, confidence: 0.9, sentenceIndex: 0 },
  { text: "acho", startMs: 260, endMs: 520, confidence: 0.8, sentenceIndex: 0 },
  { text: "que", startMs: 520, endMs: 610, confidence: 0.95, sentenceIndex: 0 },
];

describe("toTokens", () => {
  it("atribui IDs sequenciais com seis dígitos", () => {
    const tokens = toTokens(words);
    expect(tokens.map((t) => t.id)).toEqual(["w_000000", "w_000001", "w_000002"]);
  });

  it("preserva texto e tempos", () => {
    const tokens = toTokens(words);
    expect(tokens[1]).toMatchObject({
      text: "acho", startMs: 260, endMs: 520, confidence: 0.8, sentenceIndex: 0,
    });
  });

  it("arredonda tempo fracionário para inteiro", () => {
    const tokens = toTokens([
      { text: "a", startMs: 100.4, endMs: 260.6, confidence: 1, sentenceIndex: 0 },
    ]);
    expect(tokens[0]!.startMs).toBe(100);
    expect(tokens[0]!.endMs).toBe(261);
  });

  it("devolve lista vazia para entrada vazia", () => {
    expect(toTokens([])).toEqual([]);
  });
});

describe("wordOnsets", () => {
  it("devolve só os ataques, ignorando os finais", () => {
    expect(wordOnsets({ language: "pt", tokens: toTokens(words) })).toEqual([100, 260, 520]);
  });

  it("ordena e remove repetição", () => {
    const tokens = toTokens([
      { text: "b", startMs: 300, endMs: 400, confidence: 1, sentenceIndex: 0 },
      { text: "a", startMs: 100, endMs: 200, confidence: 1, sentenceIndex: 0 },
      { text: "c", startMs: 300, endMs: 500, confidence: 1, sentenceIndex: 0 },
    ]);
    expect(wordOnsets({ language: "pt", tokens })).toEqual([100, 300]);
  });

  it("devolve lista vazia sem tokens", () => {
    expect(wordOnsets({ language: "pt", tokens: [] })).toEqual([]);
  });
});

describe("wordBoundaries", () => {
  it("junta início e fim, ordenado e sem repetição", () => {
    const boundaries = wordBoundaries({ language: "pt", tokens: toTokens(words) });
    expect(boundaries).toEqual([100, 260, 520, 610]);
  });

  it("devolve lista vazia sem tokens", () => {
    expect(wordBoundaries({ language: "pt", tokens: [] })).toEqual([]);
  });
});
