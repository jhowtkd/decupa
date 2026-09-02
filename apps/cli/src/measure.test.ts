import { describe, expect, it } from "vitest";
import { evaluateGate, loadTruthBoundaries } from "./measure.ts";

describe("loadTruthBoundaries", () => {
  it("aceita o formato de arquivo de verdade", () => {
    expect(loadTruthBoundaries('{"boundariesMs":[100,260,520]}')).toEqual([100, 260, 520]);
  });

  it("ordena e remove repetição", () => {
    expect(loadTruthBoundaries('{"boundariesMs":[520,100,260,100]}')).toEqual([100, 260, 520]);
  });

  it("dá erro claro quando falta a chave", () => {
    expect(() => loadTruthBoundaries("{}")).toThrow(/boundariesMs/);
  });

  it("dá erro claro quando não é lista de números", () => {
    expect(() => loadTruthBoundaries('{"boundariesMs":["a"]}')).toThrow(/boundariesMs/);
  });
});

describe("evaluateGate", () => {
  it("passa quando p90 fica no limite", () => {
    expect(evaluateGate({ n: 10, p50Ms: 20, p90Ms: 50, maxMs: 80, meanMs: 25, unmatched: 0 })).toBe(true);
  });

  it("reprova quando p90 passa de 50 ms", () => {
    expect(evaluateGate({ n: 10, p50Ms: 20, p90Ms: 51, maxMs: 80, meanMs: 25, unmatched: 0 })).toBe(false);
  });

  it("reprova quando mais de 5% das fronteiras não acharam par", () => {
    expect(evaluateGate({ n: 90, p50Ms: 5, p90Ms: 10, maxMs: 20, meanMs: 6, unmatched: 10 })).toBe(false);
  });

  it("reprova quando não há fronteira nenhuma casada", () => {
    expect(evaluateGate({ n: 0, p50Ms: 0, p90Ms: 0, maxMs: 0, meanMs: 0, unmatched: 12 })).toBe(false);
  });
});
