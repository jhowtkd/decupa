import { describe, expect, it } from "vitest";
import type { AlignTextDeps } from "./transcribe.ts";
import { alignText, parseSidecarOutput } from "./transcribe.ts";

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

  it("lê o campo unaligned sem exigir tempo", () => {
    const out = parseSidecarOutput(JSON.stringify({
      language: "pt",
      words: [{ text: "Tom", startMs: 0, endMs: 100 }],
      unaligned: ["Nilton"],
    }));
    expect(out.unaligned).toEqual(["Nilton"]);
  });

  it("transcript antigo sem unaligned continua válido", () => {
    const out = parseSidecarOutput(JSON.stringify({ language: "pt", words: [] }));
    expect(out.unaligned).toEqual([]);
  });
});

describe("alignText", () => {
  function depsFor(stdout: string, seen: { extract?: object; args?: string[] }): AlignTextDeps {
    return {
      extract: async (opts) => { seen.extract = opts; },
      runSidecar: async (args) => { seen.args = args; return stdout; },
    };
  }

  const words = (list: { text: string; startMs: number; endMs: number }[]) =>
    JSON.stringify({ language: "pt", words: list, unaligned: [] });

  it("soma a origem uma única vez: offset 10s + 0.2s local = 10.2s", async () => {
    const seen: { extract?: object; args?: string[] } = {};
    const result = await alignText(
      { input: "fonte.mp4", text: "olá mundo", startSeconds: 10, endSeconds: 12 },
      depsFor(words([
        { text: "olá", startMs: 200, endMs: 400 },
        { text: "mundo", startMs: 450, endMs: 800 },
      ]), seen),
    );
    expect(seen.extract).toMatchObject({ input: "fonte.mp4", startSeconds: 10, durationSeconds: 2 });
    expect(seen.args).toContain("--text-file");
    expect(result.tokens.map((t) => [t.startMs, t.endMs])).toEqual([[10200, 10400], [10450, 10800]]);
  });

  it("palavra não alinhada não ganha tempo inventado: estoura nomeando", async () => {
    const seen: { extract?: object; args?: string[] } = {};
    await expect(alignText(
      { input: "fonte.mp4", text: "Nilton Pinto", startSeconds: 0, endSeconds: 2 },
      depsFor(JSON.stringify({
        language: "pt",
        words: [{ text: "Pinto", startMs: 400, endMs: 700 }],
        unaligned: ["Nilton"],
      }), seen),
    )).rejects.toThrow(/sem correspondência.*Nilton/);
  });

  it("resultado vazio e texto vazio estouram sem fingir trecho", async () => {
    const seen: { extract?: object; args?: string[] } = {};
    await expect(alignText(
      { input: "fonte.mp4", text: "olá", startSeconds: 0, endSeconds: 2 },
      depsFor(words([]), seen),
    )).rejects.toThrow(/sem correspondência/);
    await expect(alignText(
      { input: "fonte.mp4", text: "   ", startSeconds: 0, endSeconds: 2 },
      depsFor(words([]), seen),
    )).rejects.toThrow(/texto vazio/);
  });
});
