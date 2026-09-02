import { describe, expect, it } from "vitest";
import { scoreIntervals } from "./intervals.ts";

describe("scoreIntervals", () => {
  it("dá pontuação perfeita para predição idêntica", () => {
    const intervals = [{ startMs: 100, endMs: 300 }, { startMs: 500, endMs: 800 }];
    const score = scoreIntervals({ predicted: intervals, truth: intervals });
    expect(score.iou).toBe(1);
    expect(score.f1).toBe(1);
    expect(score.precisionMs).toBe(1);
    expect(score.recallMs).toBe(1);
  });

  it("dá zero quando não há sobreposição", () => {
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 100 }],
      truth: [{ startMs: 500, endMs: 600 }],
    });
    expect(score.iou).toBe(0);
    expect(score.f1).toBe(0);
  });

  it("calcula sobreposição parcial por milissegundo", () => {
    // predito 0..200, verdade 100..300 => interseção 100 ms, união 300 ms
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 200 }],
      truth: [{ startMs: 100, endMs: 300 }],
    });
    expect(score.intersectionMs).toBe(100);
    expect(score.iou).toBeCloseTo(100 / 300, 6);
    expect(score.precisionMs).toBeCloseTo(0.5, 6);
    expect(score.recallMs).toBeCloseTo(0.5, 6);
    expect(score.f1).toBeCloseTo(0.5, 6);
  });

  it("penaliza predição que corta demais", () => {
    // predito 0..1000 cobre toda a verdade 100..300, mas sobra muito
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 1000 }],
      truth: [{ startMs: 100, endMs: 300 }],
    });
    expect(score.recallMs).toBe(1);
    expect(score.precisionMs).toBeCloseTo(0.2, 6);
  });

  it("trata listas vazias sem dividir por zero", () => {
    expect(scoreIntervals({ predicted: [], truth: [] })).toMatchObject({
      iou: 1, f1: 1, precisionMs: 1, recallMs: 1,
    });
    expect(scoreIntervals({ predicted: [], truth: [{ startMs: 0, endMs: 100 }] }))
      .toMatchObject({ iou: 0, f1: 0, recallMs: 0 });
    expect(scoreIntervals({ predicted: [{ startMs: 0, endMs: 100 }], truth: [] }))
      .toMatchObject({ iou: 0, f1: 0, precisionMs: 0 });
  });

  it("funde sobreposições na entrada antes de pontuar", () => {
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 200 }, { startMs: 100, endMs: 300 }],
      truth: [{ startMs: 0, endMs: 300 }],
    });
    expect(score.iou).toBe(1);
  });
});
