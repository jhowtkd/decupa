import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Transcript } from "@decupa/transcript";
import { runCondensePrep } from "./run.ts";

const TRANSCRIPT: Transcript = {
  language: "pt",
  tokens: [
    { id: "t0", text: "oi", startMs: 0, endMs: 200, confidence: 0.9, sentenceIndex: 0 },
    { id: "t1", text: "tudo bem?", startMs: 220, endMs: 800, confidence: 0.9, sentenceIndex: 0 },
  ],
};

interface Capturado {
  language?: string;
  silences: number;
}

function deps(capturado: Capturado) {
  return {
    transcribe: async (o: { input: string; language?: string; model?: string }) => {
      capturado.language = o.language;
      return TRANSCRIPT;
    },
    detectSilence: async () => {
      capturado.silences += 1;
      return [];
    },
  };
}

describe("runCondensePrep", () => {
  it("transcreve em pt quando ninguém pede outra coisa", async () => {
    const capturado: Capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    await runCondensePrep({ input: "/vid/aula.mp4", out }, deps(capturado));
    expect(capturado.language).toBe("pt");
  });

  it("passa o idioma pedido adiante", async () => {
    // O motor trata inglês e chinês nativamente; o que é PT-BR é o léxico.
    // Transcrever em pt um material em inglês erra antes de o motor começar.
    const capturado: Capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    await runCondensePrep({ input: "/vid/talk.mp4", out, language: "en" }, deps(capturado));
    expect(capturado.language).toBe("en");
  });

  it("--no-trim não chama o detector de silêncio", async () => {
    const capturado: Capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    await runCondensePrep({ input: "/vid/aula.mp4", out, trim: false }, deps(capturado));
    expect(capturado.silences).toBe(0);
  });

  it("conta segmentos e palavras do que gravou", async () => {
    const capturado: Capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    const result = await runCondensePrep({ input: "/vid/aula.mp4", out }, deps(capturado));
    expect(result.segments).toBe(1);
    expect(result.words).toBe(2);
  });
});
