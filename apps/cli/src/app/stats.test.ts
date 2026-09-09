import { describe, expect, it } from "vitest";
import { editorialStats } from "./stats.ts";

const units = [
  { id: "u001", start: 0, end: 10 },
  { id: "u002", start: 10, end: 25 },
  { id: "u003", start: 25, end: 30 },
  { id: "u004", start: 30, end: 42 },
];

describe("editorialStats", () => {
  it("soma duração, unidades e agrupa por motivo", () => {
    const stats = editorialStats(units, [
      { unit_ids: ["u001"], reason: "preroll" },
      { unit_ids: ["u003", "u004"], reason: "retake" },
    ]);
    expect(stats.sourceSeconds).toBe(42);
    expect(stats.removedSeconds).toBe(27);
    expect(stats.outputSeconds).toBe(15);
    expect(stats.unitsRemoved).toBe(3);
    expect(stats.byReason[0]).toMatchObject({ reason: "retake", units: 2, seconds: 17 });
  });

  it("não conta duas vezes unidade dropada por duas alegações aceitas", () => {
    const stats = editorialStats(units, [
      { unit_ids: ["u001"], reason: "preroll" },
      { unit_ids: ["u001"], reason: "dead_air" },
    ]);
    expect(stats.unitsRemoved).toBe(1);
    expect(stats.removedSeconds).toBe(10);
  });

  it("resumo nomeia os números e o maior motivo", () => {
    const stats = editorialStats(units, [{ unit_ids: ["u003", "u004"], reason: "retake" }]);
    expect(stats.summary).toContain("0m17s");
    expect(stats.summary).toContain("0m42s");
    expect(stats.summary).toContain("retake");
  });

  it("sem drop, resumo honesto de nada cortado", () => {
    const stats = editorialStats(units, []);
    expect(stats.removedSeconds).toBe(0);
    expect(stats.unitsRemoved).toBe(0);
    expect(stats.summary).not.toContain("mais:");
  });
});
