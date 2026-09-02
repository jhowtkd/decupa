import { describe, expect, it } from "vitest";
import type { MeasureReport } from "./measure.ts";
import { aggregate, renderReport } from "./report.ts";

const report = (name: string, p50: number, p90: number, passed: boolean): MeasureReport => ({
  input: name,
  language: "pt",
  model: "small",
  tokenCount: 100,
  boundaries: [],
  truthBoundaries: [],
  error: { n: 20, p50Ms: p50, p90Ms: p90, maxMs: p90 + 10, meanMs: p50, unmatched: 0 },
  gatePassed: passed,
  measuredAt: "2026-09-01T00:00:00.000Z",
});

describe("aggregate", () => {
  it("conta aprovados e reprovados", () => {
    const summary = aggregate([
      report("a.wav", 10, 30, true),
      report("b.wav", 20, 45, true),
      report("c.wav", 60, 120, false),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("usa o pior p90 como veredito global", () => {
    const summary = aggregate([
      report("a.wav", 10, 30, true),
      report("c.wav", 60, 120, false),
    ]);
    expect(summary.worstP90Ms).toBe(120);
    expect(summary.gatePassed).toBe(false);
  });

  it("aprova só quando todos passam", () => {
    const summary = aggregate([report("a.wav", 10, 30, true), report("b.wav", 20, 45, true)]);
    expect(summary.gatePassed).toBe(true);
  });

  it("trata lista vazia", () => {
    const summary = aggregate([]);
    expect(summary.total).toBe(0);
    expect(summary.gatePassed).toBe(false);
  });
});

describe("renderReport", () => {
  it("gera HTML com uma linha por trecho", () => {
    const html = renderReport([report("a.wav", 10, 30, true), report("c.wav", 60, 120, false)]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("a.wav");
    expect(html).toContain("c.wav");
    expect(html).toContain("REPROVOU");
  });

  it("escapa caminho com caractere de HTML", () => {
    const html = renderReport([report("<script>.wav", 10, 30, true)]);
    expect(html).not.toContain("<script>.wav");
    expect(html).toContain("&lt;script&gt;.wav");
  });
});
