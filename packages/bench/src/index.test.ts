import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import { collectSink } from "@decupa/trace";
import { createScenarioWork, renderBenchmark, runBatchBenchmark } from "./index.ts";

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
        // Coordinator claims are file-lock + atomic publish. On Windows that
        // is slower than 8ms, so a tiny job never overlaps a second slot.
        await delay(100);
        concurrent -= 1;
        if (file.endsWith("19.wav")) throw new Error("falhou clip-19");
      },
    });
    expect(result.completed + result.failures).toBe(20);
    expect(result.failures).toBe(1);
    expect(result.queue.limit).toBe(2);
    expect(result.queue.peak).toBeGreaterThan(2);
    expect(max).toBe(2);
    expect(result.processes.peak).toBe(1);
    expect(result.sampleSize).toBe(result.latency.n);
    expect(result.latency.p95Ms).toBeGreaterThanOrEqual(result.latency.p50Ms);
    expect(result.failed).toEqual(["clip-19.wav"]);
    expect(result.ram.peakMb).toBeGreaterThan(0);
    expect(result.sampleSize).toBe(19);
    expect(renderBenchmark(result)).toMatch(/ram peak \d+ MiB/);
    expect(renderBenchmark(result)).toMatch(/sample: 19/);
    expect(renderBenchmark(result)).toMatch(/\(n=19\)/);
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
    expect(result.queue.peak).toBeGreaterThanOrEqual(4);
    expect(result.processes.peak).toBe(1);
    expect(result.throughput).toBeGreaterThan(0);
    expect(sink.events.some((e) => e.stage === "batch" && e.phase === "queued")).toBe(true);
  });

  it("cold-start carrega por arquivo e resident-models reutiliza o load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-loads-"));
    const files = [join(dir, "a.wav"), join(dir, "b.wav"), join(dir, "c.wav")];
    await Promise.all(files.map((file, i) => writeFile(file, `audio-${i}`)));
    const cold = createScenarioWork({ scenario: "cold-start", cacheDir: join(dir, "cold") });
    const coldRun = await runBatchBenchmark({
      caseId: "loads-cold",
      scenario: "cold-start",
      files,
      limit: 2,
      work: cold.work,
      stats: cold.stats,
    });
    expect(cold.stats().modelLoads).toBe(3);
    expect(coldRun.loads.modelLoads).toBe(3);
    expect(coldRun.loads.cacheHits).toBe(0);

    const resident = createScenarioWork({ scenario: "resident-models", cacheDir: join(dir, "res") });
    const residentRun = await runBatchBenchmark({
      caseId: "loads-res",
      scenario: "resident-models",
      files,
      limit: 2,
      work: resident.work,
      stats: resident.stats,
    });
    expect(resident.stats().modelLoads).toBe(1);
    expect(residentRun.loads.modelLoads).toBe(1);
  });

  it("cached-artifacts na segunda passagem não recarrega modelo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-cache-"));
    const cacheDir = join(dir, "cache");
    const files = [join(dir, "a.wav"), join(dir, "b.wav")];
    await Promise.all(files.map((file, i) => writeFile(file, `payload-${i}`)));
    const first = createScenarioWork({ scenario: "cached-artifacts", cacheDir });
    await runBatchBenchmark({
      caseId: "cache-1",
      scenario: "cached-artifacts",
      files,
      limit: 1,
      work: first.work,
      stats: first.stats,
    });
    expect(first.stats().modelLoads).toBe(2);
    expect(first.stats().cacheHits).toBe(0);
    const second = createScenarioWork({ scenario: "cached-artifacts", cacheDir });
    const replay = await runBatchBenchmark({
      caseId: "cache-2",
      scenario: "cached-artifacts",
      files,
      limit: 1,
      work: second.work,
      stats: second.stats,
    });
    expect(second.stats().modelLoads).toBe(0);
    expect(second.stats().cacheHits).toBe(2);
    expect(replay.loads.cacheHits).toBe(2);
    expect(renderBenchmark(replay)).toMatch(/cache hits 2/);
  });
});
