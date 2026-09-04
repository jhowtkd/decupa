import type { Interval } from "@decupa/core";
import { describe, expect, it } from "vitest";
import { trimTrailingSilence } from "./trim.ts";

// Silêncio detectado de 1000ms a 2000ms — a forma que `detectSilence` devolve.
const silences: Interval[] = [{ startMs: 1000, endMs: 2000 }];

describe("trimTrailingSilence", () => {
  it("encolhe a palavra esticada sobre a pausa seguinte", () => {
    // alega ir até 1500ms, mas o som para em 1000ms
    const end = trimTrailingSilence({ silences, startMs: 0, endMs: 1500 });
    expect(end).toBeGreaterThanOrEqual(1000);
    expect(end).toBeLessThanOrEqual(1100);
  });

  it("encolhe também quando a palavra atravessa a pausa inteira", () => {
    // o caso real: "né?" alegando 11s, com a pausa cobrindo quase tudo
    const end = trimTrailingSilence({ silences, startMs: 0, endMs: 2000 });
    expect(end).toBeLessThanOrEqual(1100);
  });

  it("não mexe em palavra que termina antes do silêncio", () => {
    expect(trimTrailingSilence({ silences, startMs: 0, endMs: 800 })).toBe(800);
  });

  it("corta no primeiro silêncio mesmo que haja som depois dele", () => {
    // Uma "palavra" não tem pausa de 150ms no meio: se há silêncio aqui, a
    // palavra acabou antes dele, e o que vem depois é respiração ou a próxima
    // fala — foi exatamente assim que 10,6s escaparam no material real.
    const partido: Interval[] = [
      { startMs: 400, endMs: 600 },
      { startMs: 900, endMs: 1500 },
    ];
    expect(trimTrailingSilence({ silences: partido, startMs: 0, endMs: 1500 })).toBe(460);
  });

  it("não mexe quando o span inteiro já está dentro do silêncio", () => {
    expect(trimTrailingSilence({ silences, startMs: 1100, endMs: 1400 })).toBe(1400);
  });

  it("nunca corta abaixo da duração mínima", () => {
    const end = trimTrailingSilence({
      silences, startMs: 900, endMs: 1800, minDurationMs: 300,
    });
    expect(end).toBe(1200);
  });

  it("é idempotente: aparar de novo não muda mais nada", () => {
    const first = trimTrailingSilence({ silences, startMs: 0, endMs: 1500 });
    expect(trimTrailingSilence({ silences, startMs: 0, endMs: first })).toBe(first);
  });

  it("devolve o fim original quando não há silêncio nenhum", () => {
    expect(trimTrailingSilence({ silences: [], startMs: 0, endMs: 500 })).toBe(500);
  });
});
