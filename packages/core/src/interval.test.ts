import { describe, expect, it } from "vitest";
import { mergeIntervals, totalDurationMs } from "./interval.ts";

describe("mergeIntervals", () => {
  it("funde intervalos que se sobrepõem", () => {
    expect(mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 180 },
    ])).toEqual([{ startMs: 0, endMs: 180 }]);
  });

  it("funde intervalos separados por menos que a tolerância", () => {
    expect(mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 130, endMs: 200 },
    ], 50)).toEqual([{ startMs: 0, endMs: 200 }]);
  });

  it("mantém separados os intervalos além da tolerância", () => {
    expect(mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ], 50)).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ]);
  });

  it("ordena a entrada antes de fundir", () => {
    expect(mergeIntervals([
      { startMs: 400, endMs: 500 },
      { startMs: 0, endMs: 100 },
    ])).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ]);
  });

  it("devolve lista vazia para entrada vazia", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("totalDurationMs", () => {
  it("soma a duração dos intervalos já fundidos", () => {
    expect(totalDurationMs([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ])).toBe(200);
  });

  it("não conta duas vezes o trecho sobreposto", () => {
    expect(totalDurationMs([
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 150 },
    ])).toBe(150);
  });
});
