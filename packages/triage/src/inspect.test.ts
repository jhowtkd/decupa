import { describe, expect, it } from "vitest";
import { applyInspect, flagsWithoutSubstitute, normalizeInspectVerdict } from "./inspect.ts";
import { parseSpeechIndex } from "./speech-index.ts";
import type { VisualUnitFlags } from "./visual.ts";

const index = parseSpeechIndex({
  source_duration: 20,
  budget: { lossless_floor_seconds: 10 },
  topic_runs: [{ keyword: "escala", unit_ids: ["u002", "u003"] }],
  units: [
    { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Isso não escala." },
    { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Isso não escala." },
    { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Dessa forma não escala a comunicação." },
  ],
});

const visual = (partial: Partial<VisualUnitFlags> & { id: string }): VisualUnitFlags => ({
  looksAway: false,
  handOnFace: false,
  noFace: false,
  ambiguous: false,
  samples: [],
  ...partial,
});

describe("normalizeInspectVerdict", () => {
  it("aceita drop/keep/unsure", () => {
    expect(normalizeInspectVerdict({ decision: "drop", note: "lado" }, "u001").decision).toBe("drop");
    expect(normalizeInspectVerdict({ decision: "keep" }, "u001").decision).toBe("keep");
  });

  it("vira unsure quando a decisão é lixo", () => {
    expect(normalizeInspectVerdict({ decision: "talvez" }, "u009")).toEqual({
      unitId: "u009",
      decision: "unsure",
      note: "",
    });
  });

  it("prefere unitId do payload, senão o argumento", () => {
    expect(normalizeInspectVerdict({ unitId: "u002", decision: "keep" }, "u001").unitId).toBe("u002");
  });
});

describe("applyInspect", () => {
  it("não dropa sem take substituto — só flag", () => {
    const out = applyInspect(
      [{ unitId: "u003", decision: "drop", note: "olhando para o operador" }],
      index,
      new Set(),
    );
    expect(out.claims).toEqual([]);
    expect(out.flags).toEqual([{
      unitId: "u003",
      code: "looks_away",
      source: "visual",
      message: "olhando para o operador",
    }]);
  });

  it("dropa só se houver retake posterior que confere", () => {
    const out = applyInspect(
      [{ unitId: "u001", decision: "drop", note: "olhou para o lado" }],
      index,
      new Set(),
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({
      unit_ids: ["u001"],
      reason: "retake",
      restated_by: "u002",
      source: "visual",
    });
    expect(out.flags).toEqual([]);
  });

  it("keep não gera claim nem flag", () => {
    const out = applyInspect(
      [{ unitId: "u001", decision: "keep", note: "olha para a câmera" }],
      index,
      new Set(),
    );
    expect(out.claims).toEqual([]);
    expect(out.flags).toEqual([]);
  });

  it("unsure vai para revisão", () => {
    const out = applyInspect(
      [{ unitId: "u001", decision: "unsure", note: "não dá para ver" }],
      index,
      new Set(),
    );
    expect(out.claims).toEqual([]);
    expect(out.flags[0]!.unitId).toBe("u001");
    expect(out.flags[0]!.message).toMatch(/não dá para ver/);
  });

  it("ignora unidade que já foi dropada", () => {
    const out = applyInspect(
      [{ unitId: "u001", decision: "drop", note: "x" }],
      index,
      new Set(["u001"]),
    );
    expect(out.claims).toEqual([]);
    expect(out.flags).toEqual([]);
  });
});

describe("flagsWithoutSubstitute", () => {
  it("marca visual ruim que não saiu", () => {
    const flags = flagsWithoutSubstitute(
      [visual({ id: "u003", looksAway: true })],
      new Set(),
      [],
    );
    expect(flags).toEqual([{
      unitId: "u003",
      code: "looks_away",
      source: "visual",
      message: "olhando para longe da câmera, sem take substituto",
    }]);
  });

  it("não remarca unidade que o inspect já manteve", () => {
    const flags = flagsWithoutSubstitute(
      [visual({ id: "u001", ambiguous: true })],
      new Set(),
      [],
      new Set(["u001"]),
    );
    expect(flags).toEqual([]);
  });

  it("não remarca unidade já dropada", () => {
    const flags = flagsWithoutSubstitute(
      [visual({ id: "u001", looksAway: true })],
      new Set(["u001"]),
      [],
    );
    expect(flags).toEqual([]);
  });
});
