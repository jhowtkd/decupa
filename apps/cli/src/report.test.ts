import { describe, expect, it } from "vitest";
import type { MeasureReport } from "./measure.ts";
import { aggregate, renderReport } from "./report.ts";

const report = (
  name: string,
  p50: number,
  p90: number,
  passed: boolean,
  truthMethod: string | null = "blind-keyboard",
): MeasureReport => ({
  input: name,
  language: "pt",
  model: "small",
  tokenCount: 100,
  boundaries: [],
  truthBoundaries: [],
  error: { n: 20, p50Ms: p50, p90Ms: p90, maxMs: p90 + 10, meanMs: p50, unmatched: 0 },
  gatePassed: passed,
  truthMethod,
  measuredAt: "2026-09-01T00:00:00.000Z",
});

describe("procedência da verdade", () => {
  it("conta os trechos cuja verdade não foi marcada às cegas", () => {
    const summary = aggregate([
      report("a.wav", 10, 30, true),
      report("b.wav", 10, 30, true, null),
      report("c.wav", 10, 30, true, "audacity"),
    ]);
    expect(summary.unverifiedTruth).toBe(2);
  });

  it("fecha o portão quando qualquer verdade não é cega, mesmo com p90 zero", () => {
    const summary = aggregate([report("a.wav", 0, 0, true, null)]);
    expect(summary.gatePassed).toBe(false);
  });

  it("libera o portão só quando todas passam e todas são cegas", () => {
    const summary = aggregate([report("a.wav", 10, 30, true)]);
    expect(summary.gatePassed).toBe(true);
    expect(summary.unverifiedTruth).toBe(0);
  });

  it("avisa no HTML quando a verdade não tem procedência cega", () => {
    const html = renderReport([report("a.wav", 0, 0, true, null)]);
    expect(html).toContain("procedência");
    expect(html).toContain("PORTÃO FECHADO");
  });
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
