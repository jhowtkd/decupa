import { describe, expect, it } from "vitest";
import { buildSrt, srtTimestamp, type SrtWord } from "./srt.ts";

const w = (text: string, startMs: number, endMs: number): SrtWord => ({ text, startMs, endMs });

describe("srtTimestamp", () => {
  it("formata HH:MM:SS,mmm com vírgula decimal", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(3_723_509)).toBe("01:02:03,509");
  });
});

describe("buildSrt", () => {
  const words = [
    w("o", 0, 100), w("corte", 100, 400), w("é", 500, 600),
    w("a", 3_000, 3_100), w("prosa", 3_100, 3_600),
  ];

  it("remapeia as palavras na timeline de saída, pulando o que saiu", () => {
    // Clipe 1: 0–1s da fonte. Clipe 2: 3–4s. O vão de 1–3s foi cortado —
    // na saída, "a prosa" começa em 1.000ms, não em 3.000ms.
    const srt = buildSrt({ clips: [{ start: 0, end: 1 }, { start: 3, end: 4 }], words });
    expect(srt).toContain("00:00:00,000 --> 00:00:00,600");
    expect(srt).toContain("o corte é");
    expect(srt).toContain("00:00:01,000 --> 00:00:01,600");
    expect(srt).toContain("a prosa");
  });

  it("quebra cue em pausa longa entre palavras do mesmo clipe", () => {
    const gap = [w("antes", 0, 300), w("depois", 2_000, 2_400)];
    const srt = buildSrt({ clips: [{ start: 0, end: 3 }], words: gap });
    expect(srt).toContain("antes");
    expect(srt).toContain("depois");
    // duas cues, não uma só atravessando o silêncio
    expect(srt.match(/-->/g)).toHaveLength(2);
  });

  it("respeita o teto de caracteres", () => {
    const longas = Array.from({ length: 10 }, (_, i) => w("palavramuito" + i, i * 400, i * 400 + 300));
    const srt = buildSrt({ clips: [{ start: 0, end: 10 }], words: longas, maxChars: 30 });
    for (const bloco of srt.split("\n\n")) {
      const texto = bloco.split("\n").slice(2).join(" ");
      expect(texto.length).toBeLessThanOrEqual(30);
    }
  });

  it("estoura quando não há clipe nenhum", () => {
    expect(() => buildSrt({ clips: [], words })).toThrow(/nenhum clipe/);
  });

  it("estoura quando nenhuma palavra cai nos clipes", () => {
    expect(() => buildSrt({ clips: [{ start: 10, end: 11 }], words })).toThrow(/nenhuma palavra/);
  });
});
