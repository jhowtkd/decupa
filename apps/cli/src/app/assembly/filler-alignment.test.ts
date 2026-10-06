import { expect, it } from "vitest";
import { toTokens, type RawWord } from "@decupa/transcript";
import { isFillerAligned } from "@decupa/triage";
import { toCondenseTranscript } from "../../condense/prepare.ts";
import { wordsFromTranscript } from "./analysis.ts";
import { fixtureAssembly } from "./fixture.ts";

it("propaga confiança nula da ASR pela Limpeza até as palavras da Montagem", () => {
  const raw: RawWord[] = [
    { text: "eu", startMs: 100, endMs: 200, confidence: 0.9, sentenceIndex: 0 },
    { text: "hã", startMs: 300, endMs: 400, confidence: null, sentenceIndex: 0 },
    { text: "legado", startMs: 500, endMs: 600, confidence: 0, sentenceIndex: 0 },
  ];
  const tokens = toTokens(raw);
  expect(tokens.map(token => [token.id, token.text, token.confidence])).toEqual([
    ["w_000000", "eu", 0.9], ["w_000001", "hã", null], ["w_000002", "legado", 0],
  ]);
  const condense = toCondenseTranscript({ language: "pt", tokens });
  expect(condense.segments[0]!.words.map(word => word.confidence)).toEqual([0.9, null, 0]);
  const source = fixtureAssembly().sources[0]!;
  const words = wordsFromTranscript(source, JSON.parse(JSON.stringify(condense)));
  expect(words.map(word => [word.text, word.start, word.end, word.confidence])).toEqual([
    ["eu", 0.1, 0.2, 0.9], ["hã", 0.3, 0.4, null], ["legado", 0.5, 0.6, 0],
  ]);
  expect(words.map(word => isFillerAligned(word.confidence))).toEqual([true, false, false]);
});
