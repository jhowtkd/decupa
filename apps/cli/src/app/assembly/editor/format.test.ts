import { expect, it } from "vitest";
import { clock, clockPrecise, seconds1 } from "./format.js";

it("clock mostra m:ss truncando os segundos", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(21.32)).toBe("0:21");
  expect(clock(73.12)).toBe("1:13");
  expect(clock(600)).toBe("10:00");
});

it("clockPrecise arredonda no décimo, com vírgula", () => {
  expect(clockPrecise(14.6)).toBe("0:14,6");
  expect(clockPrecise(73.12)).toBe("1:13,1");
  expect(clockPrecise(59.96)).toBe("1:00,0");
});

it("seconds1 usa vírgula decimal e unidade separada", () => {
  expect(seconds1(21.32)).toBe("21,3 s");
  expect(seconds1(4)).toBe("4,0 s");
});

it("não-finito ou negativo vira zero", () => {
  expect(clock(Number.NaN)).toBe("0:00");
  expect(clockPrecise(-3)).toBe("0:00,0");
  expect(seconds1(Number.POSITIVE_INFINITY)).toBe("0,0 s");
});
