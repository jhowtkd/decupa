import { describe, expect, it } from "vitest";
import { ncc } from "./ncc.ts";

describe("ncc", () => {
  it("dá 1 para sinais idênticos", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    expect(ncc(a, 0, a, 0, 6)).toBeCloseTo(1, 6);
  });

  it("dá -1 para sinais invertidos", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    const b = Int16Array.from([-1, -5, -3, -9, -2, -7]);
    expect(ncc(a, 0, b, 0, 6)).toBeCloseTo(-1, 6);
  });

  it("ignora deslocamento de nível (média zero)", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    const b = Int16Array.from([101, 105, 103, 109, 102, 107]);
    expect(ncc(a, 0, b, 0, 6)).toBeCloseTo(1, 6);
  });

  it("dá 0 quando um dos lados é constante", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    const flat = Int16Array.from([4, 4, 4, 4, 4, 4]);
    expect(ncc(a, 0, flat, 0, 6)).toBe(0);
  });

  it("respeita os offsets", () => {
    const a = Int16Array.from([0, 0, 1, 5, 3, 9]);
    const b = Int16Array.from([1, 5, 3, 9]);
    expect(ncc(a, 2, b, 0, 4)).toBeCloseTo(1, 6);
  });
});
