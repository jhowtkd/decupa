import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import { collectSink } from "@decupa/trace";
import { renderBenchmark, runBatchBenchmark } from "./index.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runBatchBenchmark", () => {
  it("emite manifesto com caseId, hash, cenário e hardware reais", async () => {
    const files = ["a.wav"];
    const result = await runBatchBenchmark({
      caseId: "lote-1",
      scenario: "cold-start",
      files,
      limit: 1,
      hardware: { cpus: 8, ramMb: 16384, platform: "linux" },
      hashOf: (id) => createHash("sha256").update(id).digest("hex"),
      work: async () => undefined,
    });
    expect(result.caseId).toBe("lote-1");
    expect(result.scenario).toBe("cold-start");
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.hardware).toEqual({ cpus: 8, ramMb: 16384, platform: "linux" });
    expect(result.sampleSize).toBe(1);
    expect(renderBenchmark(result)).not.toMatch(/ffmpeg -benchmark|TODO|lorem/i);
  });

  it("20 tarefas terminam ou falham explicitamente com fila limitada", async () => {
    const root = join(tmpdir(), `bench-coord-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { limit: 2, pollMs: 5 });
    const files = Array.from({ length: 20 }, (_, i) => `clip-${String(i).padStart(2, "0")}.wav`);
    let concurrent = 0;
    let max = 0;
    const result = await runBatchBenchmark({
      caseId: "lote-20",
      scenario: "cached-artifacts",
      files,
      limit: 2,
      coordinator,
      work: async (file) => {
        concurrent += 1;
        max = Math.max(max, concurrent);
        await delay(8);
        concurrent -= 1;
        if (file.endsWith("19.wav")) throw new Error("falhou clip-19");
      },
    });
    expect(result.completed + result.failures).toBe(20);
    expect(result.failures).toBe(1);
    expect(result.queue.limit).toBe(2);
    expect(result.queue.peak).toBeLessThanOrEqual(2);
    expect(max).toBe(2);
    expect(result.processes.peak).toBe(1);
    expect(result.sampleSize).toBe(result.latency.n);
    expect(result.latency.p95Ms).toBeGreaterThanOrEqual(result.latency.p50Ms);
    expect(result.failed).toEqual(["clip-19.wav"]);
  });

  it("saturação cresce a fila visível, não processos", async () => {
    const sink = collectSink();
    const files = Array.from({ length: 5 }, (_, i) => `n${i}.wav`);
    const result = await runBatchBenchmark({
      caseId: "lote-5",
      scenario: "resident-models",
      files,
      limit: 1,
      tracerSink: sink,
      work: async () => delay(12),
    });
    expect(result.queue.peak).toBe(1);
    expect(result.processes.peak).toBe(1);
    expect(result.throughput).toBeGreaterThan(0);
    expect(sink.events.some((e) => e.stage === "batch" && e.phase === "queued")).toBe(true);
  });
});
