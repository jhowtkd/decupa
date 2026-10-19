import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileCoordinator } from "@decupa/coordinator";
import {
  createOperationMetrics,
  createRealScenarioWork,
  instrumentCoordinator,
  instrumentSpeechWorker,
  runRealBenchmark,
  sampleProcessTree,
} from "./index.ts";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createOperationMetrics", () => {
  it("persists operation-scoped NDJSON with metadata and caller events", async () => {
    const dir = await tempDir("bench-metrics-");
    const metrics = createOperationMetrics({
      dir,
      operationId: "op-123",
      metadata: { sha: "abc123", machine: "test-host" },
      sampleIntervalMs: 60_000,
    });

    metrics.emit("stage", { name: "ingest", durationMs: 12 });
    await metrics.flush();
    await metrics.close();

    expect(metrics.operationId).toBe("op-123");
    expect(metrics.path).toBe(join(dir, "op-123.jsonl"));
    const rows = (await readFile(metrics.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows).toContainEqual(expect.objectContaining({
      operationId: "op-123",
      kind: "stage",
      data: { name: "ingest", durationMs: 12 },
    }));
    expect(rows.every((row) => typeof row.atMs === "number")).toBe(true);
    expect(metrics.errors).toBe(0);
  });

  it("keeps work independent from a sink persistence failure and counts errors", async () => {
    const root = await tempDir("bench-metrics-fail-");
    const dir = join(root, "not-a-directory");
    await writeFile(dir, "block mkdir");
    const metrics = createOperationMetrics({ dir, operationId: "unwritable" });

    expect(() => metrics.emit("event", { value: 1 })).not.toThrow();
    await expect(metrics.flush()).resolves.toBeUndefined();
    await expect(metrics.close()).resolves.toBeUndefined();
    expect(metrics.errors).toBeGreaterThan(0);
  });
});

describe("createRealScenarioWork", () => {
  it("runs ingest, prepare and render in order and closes cold sessions per file", async () => {
    const calls: string[] = [];
    const scenario = "cold-start" as const;
    const work = createRealScenarioWork({
      scenario,
      createSession: async ({ scenario: received, artifacts, models }) => {
        calls.push(`open:${received}:${artifacts}:${models}`);
        return {
          ingest: async (file: string) => { calls.push(`ingest:${file}`); return `i:${file}`; },
          prepare: async (value: string) => { calls.push(`prepare:${value}`); return `p:${value}`; },
          render: async (value: string) => { calls.push(`render:${value}`); },
          close: async () => { calls.push("close"); },
        };
      },
    });

    await work.work("clip-a.mp4");
    await work.work("clip-b.mp4");

    expect(calls).toEqual([
      "open:cold-start:fresh:cold", "ingest:clip-a.mp4", "prepare:i:clip-a.mp4", "render:p:i:clip-a.mp4", "close",
      "open:cold-start:fresh:cold", "ingest:clip-b.mp4", "prepare:i:clip-b.mp4", "render:p:i:clip-b.mp4", "close",
    ]);
    // Model loads are observations from the adapter, never inferred from the scenario label.
    expect(work.stats()).toEqual({ modelLoads: 0, cacheHits: 0 });
  });

  it.each([
    ["resident-models", "fresh", "resident"],
    ["cached-artifacts", "reuse", "resident"],
  ] as const)("uses one %s session with %s artifacts", async (scenario, artifacts, models) => {
    let opens = 0;
    let closes = 0;
    const work = createRealScenarioWork({
      scenario,
      createSession: async (options) => {
        opens += 1;
        expect(options).toEqual({ scenario, artifacts, models });
        return {
          ingest: async (file: string) => file,
          prepare: async (value: string) => value,
          render: async () => undefined,
          close: async () => { closes += 1; },
        };
      },
    });
    await work.work("one.mp4");
    await work.work("two.mp4");
    await work.close();
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });
});

describe("instrumentation adapters", () => {
  it("samples a controlled child process in the current process tree", async () => {
    if (process.platform !== "linux") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const sample = await sampleProcessTree();
      expect(sample.scope).toBe("process-tree");
      expect(sample.processes).toBeGreaterThanOrEqual(2);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  it("records coordinator queue and cache-hit-or-shared outcomes", async () => {
    const dir = await tempDir("bench-coordinator-");
    const metrics = createOperationMetrics({ dir, operationId: "coord", sampleIntervalMs: 60_000 });
    const coordinator = createFileCoordinator(join(dir, "coordination"), { limit: 1, pollMs: 5 });
    const observed = instrumentCoordinator(coordinator, metrics)!;
    let builds = 0;

    await observed.run({ id: "same-file", stage: "ingest", build: async () => { builds += 1; return "artifact"; } });
    await observed.run({ id: "same-file", stage: "ingest", build: async () => { builds += 1; return "unexpected"; } });
    await metrics.close();

    const journal = await readFile(metrics.path, "utf8");
    expect(builds).toBe(1);
    expect(journal).toContain('"kind":"queue"');
    expect(journal).toContain('"kind":"cache"');
    expect(journal).toContain('"outcome":"hit-or-shared"');
  });

  it("records ASR and alignment acquisition intervals without claiming physical loads", async () => {
    const dir = await tempDir("bench-speech-");
    const metrics = createOperationMetrics({ dir, operationId: "speech", sampleIntervalMs: 60_000 });
    const worker = instrumentSpeechWorker(async (request: { onProgress?: (line: string) => void; language: string }) => {
      request.onProgress?.("carregando o modelo de fala");
      request.onProgress?.("transcrevendo");
      request.onProgress?.("carregando o modelo de alinhamento");
      request.onProgress?.("alinhando");
      return "done";
    }, metrics);

    await expect(worker({ language: "pt" })).resolves.toBe("done");
    await metrics.close();
    const journal = await readFile(metrics.path, "utf8");
    expect(journal).toContain('"stage":"asr-model-acquire"');
    expect(journal).toContain('"stage":"alignment-model-acquire"');
    expect(journal).toContain('"physicalModelLoads":null');
  });
});

describe("runRealBenchmark", () => {
  it("executes injected real stages and leaves p95 unavailable below 20 samples", async () => {
    const dir = await tempDir("bench-real-");
    const files = [join(dir, "pilot.mp4")];
    await writeFile(files[0]!, "video fixture");
    const calls: string[] = [];
    const result = await runRealBenchmark({
      caseId: "pilot-dji-mimo",
      scenario: "cold-start",
      files,
      limit: 1,
      sha: "fixture-sha256",
      config: { concurrency: 1 },
      media: [{ path: files[0]!, sha256: "a".repeat(64), durationSeconds: 104, bytes: 13 }],
      outputDir: dir,
      verifyUsable: async () => undefined,
      createSession: async () => ({
        ingest: async (file: string) => { calls.push("ingest"); return { file }; },
        prepare: async (value: { file: string }) => { calls.push("prepare"); return value; },
        render: async () => { calls.push("render"); },
      }),
    });

    expect(calls).toEqual(["ingest", "prepare", "render"]);
    expect(result).toMatchObject({
      kind: "real",
      caseId: "pilot-dji-mimo",
      scenario: "cold-start",
      sha: "fixture-sha256",
      config: { concurrency: 1 },
      latency: { n: 1, p95Ms: null, minimumP95Samples: 20 },
      operations: [{ firstUsableAssemblyMs: expect.any(Number), persistenceErrors: 0 }],
    });
    const operationMetrics = await readFile(result.operations[0]!.metricsPath, "utf8");
    expect(operationMetrics).toContain('"kind":"operation"');
    expect(operationMetrics).toContain('"kind":"operation-finished"');
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { sha: string; config: unknown };
    expect(manifest).toMatchObject({ sha: "fixture-sha256", config: { concurrency: 1 } });
  });

  it("keeps pipeline readiness separate from editor usability when no verifier is supplied", async () => {
    const dir = await tempDir("bench-real-unverified-");
    const file = join(dir, "clip.mp4");
    await writeFile(file, "video fixture");
    const result = await runRealBenchmark({
      caseId: "unverified-editor",
      scenario: "cold-start",
      files: [file],
      sha: "b".repeat(64),
      config: { concurrency: 1 },
      media: [{ path: file, sha256: "c".repeat(64), durationSeconds: 5, bytes: 13 }],
      outputDir: dir,
      createSession: async () => ({
        ingest: async () => "ingested",
        prepare: async () => "prepared",
        render: async () => undefined,
      }),
    });

    expect(result.operations[0]).toMatchObject({
      pipelineReadyMs: expect.any(Number),
      firstUsableAssemblyMs: null,
    });
    expect(result.operations[0]?.error).toBeUndefined();
  });

  it("persists a session close failure in the report and operation journal", async () => {
    const dir = await tempDir("bench-real-close-failure-");
    const file = join(dir, "clip.mp4");
    await writeFile(file, "video fixture");
    const result = await runRealBenchmark({
      caseId: "close-failure",
      scenario: "resident-models",
      files: [file],
      sha: "d".repeat(64),
      config: { concurrency: 1 },
      media: [{ path: file, sha256: "e".repeat(64), durationSeconds: 5, bytes: 13 }],
      outputDir: dir,
      createSession: async () => ({
        ingest: async () => "ingested",
        prepare: async () => "prepared",
        render: async () => undefined,
        close: async () => { throw new Error("session close failed"); },
      }),
    });

    expect(result.operations[0]?.error).toContain("session close failed");
    expect(result.latency.n).toBe(0);
    const journal = await readFile(result.operations[0]!.metricsPath, "utf8");
    expect(journal).toContain('"kind":"operation-finished"');
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
      operations: Array<{ error?: string }>;
    };
    expect(manifest.operations[0]?.error).toContain("session close failed");
  });
});
