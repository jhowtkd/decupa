import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, STRUCTURE_INSTRUCTIONS, buildUnitsBlock } from "./prompt.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const index = parseSpeechIndex({
  units: [
    { id: "u001", index: 0, start: 8.491, end: 11.815, duration: 3.324,
      text: "Eu esqueci o começo, perdão.", has_terminal_punct: true, is_question: false },
    { id: "u002", index: 1, start: 17.37, end: 21.58, duration: 4.21,
      text: "Agora vai, calma aí.", has_terminal_punct: true, is_question: false },
  ],
});

describe("buildUnitsBlock", () => {
  it("põe uma unidade por linha, com id, tempo e texto", () => {
    const block = buildUnitsBlock(index);
    expect(block.split("\n")).toHaveLength(2);
    expect(block).toContain("u001");
    expect(block).toContain("Eu esqueci o começo, perdão.");
  });

  it("usa segundos com uma casa, não MM:SS", () => {
    // MM:SS é o formato que o Gemini usa e que não serve para corte;
    // mandar segundos deixa claro que o tempo é do índice, não dele.
    const block = buildUnitsBlock(index);
    expect(block).toContain("8.5");
    expect(block).not.toMatch(/\d+:\d\d/);
  });

  it("não vaza quebra de linha do texto da unidade", () => {
    const dirty = parseSpeechIndex({
      units: [{ id: "u001", index: 0, start: 0, end: 1, duration: 1, text: "uma\nduas" }],
    });
    expect(buildUnitsBlock(dirty).split("\n")).toHaveLength(1);
  });
});

describe("STRUCTURE_INSTRUCTIONS", () => {
  it("proíbe o modelo de emitir tempo", () => {
    expect(STRUCTURE_INSTRUCTIONS.toLowerCase()).toContain("nunca");
    expect(STRUCTURE_INSTRUCTIONS).toContain("unit_ids");
  });

  it("tem versão fixada, que entra na chave de cache", () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
