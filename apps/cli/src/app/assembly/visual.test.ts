import { expect, it } from "vitest";
import { fixtureSourceA, validateVisual, visualAt, visualWindows } from "./visual.ts";

it("consulta no segundo 1 devolve só o segundo intervalo", () => {
  expect(visualAt([
    { id: "a:0", sourceId: "a", start: 0, end: 1, text: "mesa", confidence: "observed", tags: [] },
    { id: "a:1", sourceId: "a", start: 1, end: 2, text: "mão", confidence: "observed", tags: [] },
  ], 1).map((s) => s.id)).toEqual(["a:1"]);
});

it("recusa fim além da duração e fonte inventada", () => {
  const source = fixtureSourceA();
  expect(() => validateVisual([
    { id: "a:0", sourceId: "a", start: 0, end: 9, text: "x", confidence: "observed", tags: [] },
  ], source)).toThrow(/depois da fonte/);
  expect(() => validateVisual([
    { id: "z:0", sourceId: "z", start: 0, end: 1, text: "x", confidence: "observed", tags: [] },
  ], source)).toThrow(/inventada/);
});

it("divide a fonte em janelas de 20s com 1s de contexto", () => {
  const windows = visualWindows(45);
  expect(windows).toEqual([
    { start: 0, end: 20, fetchStart: 0 },
    { start: 20, end: 40, fetchStart: 19 },
    { start: 40, end: 45, fetchStart: 39 },
  ]);
});
