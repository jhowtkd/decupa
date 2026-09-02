import { describe, expect, it } from "vitest";
import { computePeaks } from "./peaks.ts";

describe("computePeaks", () => {
  it("produz um par min/max por balde", () => {
    // 1000 amostras, balde de 100 => 10 baldes
    const pcm = new Int16Array(1000);
    const peaks = computePeaks(pcm, { sampleRate: 1000, bucketsPerSecond: 10 });
    expect(peaks.bucketsPerSecond).toBe(10);
    expect(peaks.min.length).toBe(10);
    expect(peaks.max.length).toBe(10);
  });

  it("captura o pico real de cada balde", () => {
    const pcm = new Int16Array(200);
    pcm[50] = 16_384; // metade da escala, no primeiro balde
    pcm[150] = -8_192; // um quarto negativo, no segundo
    const peaks = computePeaks(pcm, { sampleRate: 200, bucketsPerSecond: 2 });
    expect(peaks.max[0]).toBeCloseTo(0.5, 3);
    expect(peaks.min[1]).toBeCloseTo(-0.25, 3);
  });

  it("normaliza para -1..1", () => {
    const pcm = Int16Array.from([32_767, -32_768, 0, 0]);
    const peaks = computePeaks(pcm, { sampleRate: 4, bucketsPerSecond: 1 });
    expect(peaks.max[0]).toBeLessThanOrEqual(1);
    expect(peaks.min[0]).toBeGreaterThanOrEqual(-1);
  });

  it("silêncio dá min e max zerados", () => {
    const peaks = computePeaks(new Int16Array(400), { sampleRate: 400, bucketsPerSecond: 4 });
    expect([...peaks.max]).toEqual([0, 0, 0, 0]);
    expect([...peaks.min]).toEqual([0, 0, 0, 0]);
  });

  it("descarta o balde incompleto do fim", () => {
    // 250 amostras com balde de 100 => 2 baldes, sobra 50 descartada
    const peaks = computePeaks(new Int16Array(250), { sampleRate: 1000, bucketsPerSecond: 10 });
    expect(peaks.max.length).toBe(2);
  });

  it("devolve baldes vazios para pcm vazio", () => {
    const peaks = computePeaks(new Int16Array(0), { sampleRate: 1000, bucketsPerSecond: 10 });
    expect(peaks.max.length).toBe(0);
  });
});
