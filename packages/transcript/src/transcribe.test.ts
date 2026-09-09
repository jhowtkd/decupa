import { describe, expect, it } from "vitest";
import { parseSidecarOutput } from "./transcribe.ts";

describe("parseSidecarOutput", () => {
  it("lê language e words", () => {
    const out = parseSidecarOutput(
      JSON.stringify({ language: "pt", words: [{ text: "oi", startMs: 0, endMs: 100 }] }),
    );
    expect(out.language).toBe("pt");
    expect(out.words).toHaveLength(1);
  });

  it("aceita transcrição de áudio mudo: words vazio é válido", () => {
    expect(parseSidecarOutput(JSON.stringify({ language: "pt", words: [] })).words).toEqual([]);
  });

  it("stdout não-JSON estoura com o começo da saída, não com SyntaxError cru", () => {
    expect(() => parseSidecarOutput("Downloading model...\n")).toThrow(/não é JSON.*Downloading/);
  });

  it("saída sem a forma prometida nomeia o sidecar", () => {
    expect(() => parseSidecarOutput(JSON.stringify({ ok: true }))).toThrow(/transcribe\.py/);
  });
});
