import { describe, expect, it } from "vitest";
import { coverageComplete, coveredSeconds, newCoverage, playbackReading } from "./playback.js";

type Coverage = ReturnType<typeof newCoverage>;
const DURATION = 73.12;

/** Reprodução de verdade: um timeupdate a cada `step` s de mídia, no ritmo do relógio. */
function play(cov: Coverage, from: number, to: number, { step = 0.25, rate = 1 } = {}): Coverage {
  let current = cov;
  for (let t = from + step; t < to; t += step) {
    current = playbackReading(current, t, { elapsed: step / rate, rate }).coverage;
  }
  return playbackReading(current, to, { elapsed: step / rate, rate }).coverage;
}

describe("cobertura da prévia (#103)", () => {
  it("seek direto para o fim, sem play: nada tocado, continua travado", () => {
    const seek = playbackReading(newCoverage(), 73.1, { seek: true });
    expect(seek.reset).toBe(false);
    expect(coveredSeconds(seek.coverage, DURATION)).toBe(0);
    expect(coverageComplete(seek.coverage, DURATION)).toBe(false);
    // Mesmo sem o aviso de seek, um salto maior que o relógio não conta.
    const jump = playbackReading(newCoverage(), 73.1, { elapsed: 0.25 });
    expect(coveredSeconds(jump.coverage, DURATION)).toBe(0);
    expect(coverageComplete(jump.coverage, DURATION)).toBe(false);
  });

  it("seek até a metade e play até o fim: falta a primeira metade", () => {
    const half = playbackReading(newCoverage(), DURATION / 2, { seek: true }).coverage;
    const cov = play(half, DURATION / 2, DURATION);
    expect(coveredSeconds(cov, DURATION)).toBeCloseTo(DURATION / 2, 1);
    expect(coverageComplete(cov, DURATION)).toBe(false);
  });

  it("play contínuo do início ao fim: libera", () => {
    const cov = play(newCoverage(), 0, DURATION);
    expect(coveredSeconds(cov, DURATION)).toBeCloseTo(DURATION, 5);
    expect(coverageComplete(cov, DURATION)).toBe(true);
  });

  it("play com pausas e retomadas, sem saltos: libera", () => {
    let cov = play(newCoverage(), 0, 20);
    // Pausa: o timeupdate da pausa repete a posição, e a retomada segue do mesmo ponto.
    cov = playbackReading(cov, 20, { elapsed: 0 }).coverage;
    cov = play(cov, 20, 51.3);
    cov = playbackReading(cov, 51.3, { elapsed: 0 }).coverage;
    cov = play(cov, 51.3, DURATION);
    expect(coverageComplete(cov, DURATION)).toBe(true);
  });

  it("voltar no meio do play reinicia a contagem", () => {
    const watched = play(newCoverage(), 0, 40);
    const back = playbackReading(watched, 20, { seek: true });
    expect(back.reset).toBe(true);
    expect(coveredSeconds(back.coverage, DURATION)).toBe(0);
    // Do ponto para onde voltou até o fim não basta: a contagem recomeçou em 20 s.
    expect(coverageComplete(play(back.coverage, 20, DURATION), DURATION)).toBe(false);
    // Voltar pelo timeupdate (sem o aviso de seek) também reinicia.
    expect(playbackReading(watched, 20, { elapsed: 0.25 }).reset).toBe(true);
  });

  it("seek para a frente no meio abre um buraco que o fim não fecha", () => {
    let cov = play(newCoverage(), 0, 30);
    cov = playbackReading(cov, 45, { seek: true }).coverage;
    cov = play(cov, 45, DURATION);
    expect(coveredSeconds(cov, DURATION)).toBeCloseTo(DURATION - 15, 1);
    expect(coverageComplete(cov, DURATION)).toBe(false);
  });

  it("travada da página e playbackRate alto continuam contando como reprodução", () => {
    // Página ocupada por 0,9 s: a mídia andou 0,9 s no mesmo tempo de relógio.
    let cov = play(newCoverage(), 0, 10);
    cov = playbackReading(cov, 10.9, { elapsed: 0.9 }).coverage;
    cov = play(cov, 10.9, DURATION);
    expect(coverageComplete(cov, DURATION)).toBe(true);
    // A 16x cada timeupdate avança 4 s de mídia em 0,25 s de relógio.
    expect(coverageComplete(play(newCoverage(), 0, DURATION, { step: 4, rate: 16 }), DURATION)).toBe(true);
  });

  it("bordas: fim a menos de uma leitura da duração ainda completa; duração inválida nunca", () => {
    const almost = play(newCoverage(), 0, DURATION - 0.2);
    expect(coverageComplete(almost, DURATION)).toBe(true);
    const short = play(newCoverage(), 0, DURATION - 1);
    expect(coverageComplete(short, DURATION)).toBe(false);
    expect(coverageComplete(play(newCoverage(), 0, 10), Number.NaN)).toBe(false);
    expect(coveredSeconds(newCoverage(), Number.NaN)).toBe(0);
  });
});
