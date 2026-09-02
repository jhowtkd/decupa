import { describe, expect, it } from "vitest";
import { boundaryError } from "./boundary.ts";

describe("boundaryError", () => {
  it("dá erro zero para fronteiras idênticas", () => {
    const result = boundaryError({ predicted: [100, 200, 300], truth: [100, 200, 300] });
    expect(result.n).toBe(3);
    expect(result.p50Ms).toBe(0);
    expect(result.p90Ms).toBe(0);
    expect(result.maxMs).toBe(0);
    expect(result.unmatched).toBe(0);
  });

  it("mede a distância absoluta até a fronteira mais próxima", () => {
    const result = boundaryError({ predicted: [110, 190, 305], truth: [100, 200, 300] });
    expect(result.n).toBe(3);
    expect(result.maxMs).toBe(10);
    expect(result.meanMs).toBeCloseTo((10 + 10 + 5) / 3, 6);
  });

  it("calcula p50 e p90 sobre os erros ordenados", () => {
    // erros: 0,1,2,3,4,5,6,7,8,92 (verdade 900 casa com 808, não com 1000)
    // nearest-rank: p50 = índice ceil(5)-1 = 4 -> 4 · p90 = índice ceil(9)-1 = 8 -> 8
    const truth = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
    const predicted = [0, 101, 202, 303, 404, 505, 606, 707, 808, 1000];
    const result = boundaryError({ predicted, truth, toleranceMs: 200 });
    expect(result.p50Ms).toBe(4);
    expect(result.p90Ms).toBe(8);
    expect(result.maxMs).toBe(92);
  });

  it("conta como unmatched a fronteira sem par dentro da tolerância", () => {
    const result = boundaryError({
      predicted: [100],
      truth: [100, 5000],
      toleranceMs: 200,
    });
    expect(result.n).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.p50Ms).toBe(0);
  });

  it("devolve zeros e unmatched total quando não há predição", () => {
    const result = boundaryError({ predicted: [], truth: [100, 200] });
    expect(result.n).toBe(0);
    expect(result.unmatched).toBe(2);
    expect(result.p50Ms).toBe(0);
    expect(result.p90Ms).toBe(0);
  });
});
