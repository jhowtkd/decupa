import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import type { FileCoordinator } from "@decupa/coordinator";
import { createLimitedQueue } from "@decupa/queue";
import { createTracer, type TraceSink } from "@decupa/trace";

export type BenchmarkScenario = "cold-start" | "resident-models" | "cached-artifacts";

export type HardwareInfo = {
  cpus: number;
  ramMb: number;
  platform: string;
};

export type BenchWorkStats = {
  modelLoads: number;
  cacheHits: number;
};

export type BenchmarkManifest = {
  kind: "synthetic";
  caseId: string;
  hash: string;
  scenario: BenchmarkScenario;
  hardware: HardwareInfo;
  batchSize: number;
  sampleSize: number;
  completed: number;
  failures: number;
  failed: string[];
  throughput: number;
  latency: { n: number; p50Ms: number; p95Ms: number };
  ram: { peakMb: number };
  queue: { limit: number; peak: number };
  processes: { peak: number };
  loads: BenchWorkStats;
};

export type BatchBenchmarkOptions = {
  caseId: string;
  scenario: BenchmarkScenario;
  files: readonly string[];
  limit: number;
  work: (file: string) => Promise<void> | void;
  stats?: () => BenchWorkStats;
  coordinator?: FileCoordinator;
  hardware?: HardwareInfo;
  hashOf?: (material: string) => string;
  tracerSink?: TraceSink;
  now?: () => number;
};

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

function defaultHardware(): HardwareInfo {
  return {
    cpus: Math.max(1, cpus().length),
    ramMb: Math.round(totalmem() / (1024 * 1024)),
    platform: platform(),
  };
}

function digest(material: string): string {
  return createHash("sha256").update(material).digest("hex");
}

function preloadModel(): void {
  createHash("sha256").update("decupa-bench-model").digest("hex");
}

/** Synthetic hash/cache exercise. Does not run media, ASR, or rendering. */
export function createScenarioWork(opts: {
  scenario: BenchmarkScenario;
  cacheDir: string;
}): { work: (file: string) => Promise<void>; stats: () => BenchWorkStats } {
  const stats: BenchWorkStats = { modelLoads: 0, cacheHits: 0 };
  let resident: Promise<void> | null = null;
  const work = async (file: string): Promise<void> => {
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (opts.scenario === "cached-artifacts") {
      await mkdir(opts.cacheDir, { recursive: true });
      const cached = join(opts.cacheDir, hash);
      const hit = await access(cached).then(() => true, () => false);
      if (hit) {
        stats.cacheHits += 1;
        await readFile(cached);
        return;
      }
      stats.modelLoads += 1;
      preloadModel();
      await writeFile(cached, hash, "utf8");
      return;
    }
    if (opts.scenario === "resident-models") {
      if (!resident) {
        resident = Promise.resolve().then(() => {
          stats.modelLoads += 1;
          preloadModel();
        });
      }
      await resident;
      return;
    }
    stats.modelLoads += 1;
    preloadModel();
  };
  return { work, stats: () => ({ ...stats }) };
}

export async function runBatchBenchmark(opts: BatchBenchmarkOptions): Promise<BenchmarkManifest> {
  const now = opts.now ?? Date.now;
  const tracer = createTracer(opts.tracerSink);
  const limit = opts.limit;
  const queue = createLimitedQueue(limit);
  const coordinator = opts.coordinator;
  let peakRssMb = 0;
  const durations: number[] = [];
  const failed: string[] = [];
  const started = now();
  const sampleRam = (): void => {
    peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / (1024 * 1024)));
  };

  return tracer.run("batch", async () => {
    await Promise.all(opts.files.map(async (file) => {
      const run = async (): Promise<void> => {
        sampleRam();
        const t0 = now();
        try {
          await opts.work(file);
          durations.push(Math.max(0, now() - t0));
        } catch {
          failed.push(file);
        }
      };
      await queue.run(async () => {
        if (coordinator) {
          await coordinator.run({ id: file, stage: "batch", build: run });
          return;
        }
        await run();
      }, { key: file });
    }));
    sampleRam();

    const elapsedSec = Math.max(0.001, (now() - started) / 1000);
    const completed = opts.files.length - failed.length;
    const hardware = opts.hardware ?? defaultHardware();
    const material = `${opts.caseId}|${opts.scenario}|${opts.files.join("|")}`;
    return {
      kind: "synthetic",
      caseId: opts.caseId,
      hash: (opts.hashOf ?? digest)(material),
      scenario: opts.scenario,
      hardware,
      batchSize: opts.files.length,
      sampleSize: durations.length,
      completed,
      failures: failed.length,
      failed,
      throughput: completed / elapsedSec,
      latency: {
        n: durations.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      },
      ram: { peakMb: peakRssMb },
      queue: { limit, peak: queue.maxWaiting },
      processes: { peak: 1 },
      loads: opts.stats?.() ?? { modelLoads: 0, cacheHits: 0 },
    };
  });
}

export function renderBenchmark(manifest: BenchmarkManifest): string {
  return [
    `# synthetic benchmark ${manifest.caseId}`,
    "workload: synthetic SHA256/cache exercise; no ingest, speech models, or render",
    `hash: ${manifest.hash}`,
    `scenario: ${manifest.scenario}`,
    `hardware: ${manifest.hardware.cpus} cpus · ${manifest.hardware.ramMb} MiB · ${manifest.hardware.platform}`,
    `batch: ${manifest.batchSize} · sample: ${manifest.sampleSize}`,
    `throughput: ${manifest.throughput.toFixed(3)} /s`,
    `latency p50: ${manifest.latency.p50Ms} ms · p95: ${manifest.latency.p95Ms} ms (n=${manifest.latency.n})`,
    `queue limit ${manifest.queue.limit} peak ${manifest.queue.peak} · processes peak ${manifest.processes.peak}`,
    `ram peak ${manifest.ram.peakMb} MiB`,
    `loads: models ${manifest.loads.modelLoads} · cache hits ${manifest.loads.cacheHits}`,
    `completed ${manifest.completed} · failures ${manifest.failures}${manifest.failed.length ? ` (${manifest.failed.join(", ")})` : ""}`,
  ].join("\n");
}

export type OperationMetrics = ReturnType<typeof createOperationMetrics>;

type ResourceSample = {
  scope: "process-tree" | "self-only";
  processes: number;
  rssMb: number;
  /** Linux clock ticks, including descendants already reaped by their parent. */
  cpuTicks?: number;
  readBytes?: number;
  writeBytes?: number;
  incomplete?: boolean;
};

/** Samples descendants of this process only; never scans or signals unrelated PIDs. */
export async function sampleProcessTree(): Promise<ResourceSample> {
  if (process.platform !== "linux") {
    return { scope: "self-only", processes: 1, rssMb: process.memoryUsage().rss / 1048576 };
  }
  const pending = [process.pid];
  const seen = new Set<number>();
  let rss = 0, cpuTicks = 0, readBytes = 0, writeBytes = 0;
  let incomplete = false;
  while (pending.length) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    try {
      const root = `/proc/${pid}`;
      const [status, stats, io, threads] = await Promise.all([
        readFile(`${root}/status`, "utf8"), readFile(`${root}/stat`, "utf8"),
        readFile(`${root}/io`, "utf8").catch(() => { incomplete = true; return ""; }),
        readdir(`${root}/task`),
      ]);
      seen.add(pid);
      rss += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      const fields = stats.slice(stats.lastIndexOf(")") + 2).trim().split(/\s+/);
      cpuTicks += [11, 12, 13, 14].reduce((sum, index) => sum + Number(fields[index] ?? 0), 0);
      readBytes += Number(io.match(/^read_bytes:\s+(\d+)/m)?.[1] ?? 0);
      writeBytes += Number(io.match(/^write_bytes:\s+(\d+)/m)?.[1] ?? 0);
      // A subprocess may be spawned by any thread, not just the main one.
      const children = await Promise.all(threads.map(thread => readFile(`${root}/task/${thread}/children`, "utf8").catch(() => "")));
      for (const child of children.join(" ").trim().split(/\s+/)) {
        if (/^\d+$/.test(child)) pending.push(Number(child));
      }
    } catch { incomplete = true; } // A child can exit during a sample.
  }
  return { scope: "process-tree", processes: seen.size, rssMb: rss / 1048576, cpuTicks, readBytes, writeBytes, incomplete };
}

/** One append-only journal per operation. No prompts, credentials, argv or media contents. */
export function createOperationMetrics(opts: {
  dir: string;
  operationId?: string;
  metadata?: Record<string, unknown>;
  sampleIntervalMs?: number;
}) {
  const operationId = opts.operationId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error("invalid metrics operation ID");
  const path = join(opts.dir, `${operationId}.jsonl`);
  let errors = 0, closed = false;
  let writes = mkdir(opts.dir, { recursive: true }).then(() => undefined).catch(() => { errors += 1; });
  const emit = (kind: string, data: unknown): void => {
    if (closed) return;
    try {
      const line = `${JSON.stringify({ operationId, kind, atMs: Date.now(), data })}\n`;
      writes = writes.then(() => appendFile(path, line, { mode: 0o600 })).catch(() => { errors += 1; });
    } catch { errors += 1; }
  };
  const tracer = createTracer({ emit: event => emit("trace", event) });
  let sampling: Promise<void> | undefined;
  const sample = (): Promise<void> => {
    sampling ??= sampleProcessTree().then(value => emit("resources", value)).catch(() => { errors += 1; }).finally(() => { sampling = undefined; });
    return sampling;
  };
  emit("operation", { ...opts.metadata, pid: process.pid, resourceAttribution: "process tree shared by overlapping operations; sampled peaks are lower bounds" });
  void sample();
  const interval = setInterval(() => { void sample(); }, Math.max(50, opts.sampleIntervalMs ?? 500));
  interval.unref();
  return {
    operationId, path, tracer, emit,
    get errors() { return errors; },
    async flush(): Promise<void> { await sampling; await writes; },
    async close(): Promise<void> {
      if (closed) return;
      clearInterval(interval);
      await sampling;
      await sample();
      emit("operation-finished", { persistenceErrors: errors });
      closed = true;
      await writes;
    },
  };
}

/** Retains the coordinator's cache, priority and cancellation semantics. */
export function instrumentCoordinator(coordinator: FileCoordinator | undefined, metrics: OperationMetrics): FileCoordinator | undefined {
  if (!coordinator) return undefined;
  return {
    async run<T>(opts: Parameters<FileCoordinator["run"]>[0]): Promise<T> {
      const id = randomUUID(), queued = Date.now();
      let built = false;
      metrics.emit("queue", { id, stage: opts.stage, phase: "queued" });
      try {
        const result = await coordinator.run({ ...opts, build: () => {
          built = true;
          metrics.emit("queue", { id, stage: opts.stage, phase: "started", waitMs: Date.now() - queued });
          return metrics.tracer.run(opts.stage, opts.build, { signal: opts.signal });
        } });
        metrics.emit("cache", { stage: opts.stage, outcome: built ? "built" : "hit-or-shared" });
        return result as T;
      } finally { metrics.emit("queue", { id, stage: opts.stage, phase: "finished", elapsedMs: Date.now() - queued }); }
    },
    async withSlot<T>(opts: Parameters<FileCoordinator["withSlot"]>[0], fn: () => Promise<T> | T): Promise<T> {
      const id = randomUUID(), queued = Date.now();
      metrics.emit("queue", { id, stage: opts.stage, phase: "queued" });
      try {
        return await coordinator.withSlot(opts, () => {
          metrics.emit("queue", { id, stage: opts.stage, phase: "started", waitMs: Date.now() - queued });
          return metrics.tracer.run(opts.stage, fn, { signal: opts.signal });
        });
      } finally { metrics.emit("queue", { id, stage: opts.stage, phase: "finished", elapsedMs: Date.now() - queued }); }
    },
  };
}

/** Progress exposes model acquisition time (including reuse), not physical load counts. */
export function instrumentSpeechWorker<R extends { onProgress?: (line: string) => void; signal?: AbortSignal; model?: string; language: string }, T>(
  worker: (req: R) => Promise<T>, metrics: OperationMetrics,
): (req: R) => Promise<T> {
  return async req => {
    let stage = "startup", began = Date.now();
    const finish = (): void => metrics.emit("speech-stage", { stage, durationMs: Date.now() - began });
    metrics.emit("speech-call", { model: req.model ?? "small", language: req.language, physicalModelLoads: null });
    try {
      return await metrics.tracer.run("speech", () => worker({ ...req, onProgress: (line: string) => {
        const next = line.startsWith("carregando o modelo de fala") ? "asr-model-acquire"
          : line.startsWith("carregando o modelo de alinhamento") ? "alignment-model-acquire"
          : line.startsWith("alinhando") ? "alignment"
          : line.startsWith("transcrevendo") ? "asr"
          : line.startsWith("lendo o áudio") ? "read-audio" : stage;
        if (next !== stage) { finish(); stage = next; began = Date.now(); }
        req.onProgress?.(line);
      } }), { signal: req.signal });
    } finally { finish(); }
  };
}

export type RealSessionPolicy = {
  scenario: BenchmarkScenario;
  artifacts: "fresh" | "reuse";
  models: "cold" | "resident";
};
export type RealBenchmarkSession = {
  ingest(file: string): Promise<unknown>;
  prepare(ingested: unknown): Promise<unknown>;
  render(prepared: unknown): Promise<unknown>;
  close?(): Promise<void> | void;
};
export type RealSessionFactory = (policy: RealSessionPolicy, metrics?: OperationMetrics) => Promise<RealBenchmarkSession> | RealBenchmarkSession;

/** The adapter supplies production ingest, analysis/preparation and render. No fabricated workload. */
export function createRealScenarioWork(opts: {
  scenario: BenchmarkScenario;
  createSession: RealSessionFactory;
  metrics?: OperationMetrics;
}) {
  let resident: Promise<RealBenchmarkSession> | undefined;
  const policy: RealSessionPolicy = {
    scenario: opts.scenario,
    artifacts: opts.scenario === "cached-artifacts" ? "reuse" : "fresh",
    models: opts.scenario === "cold-start" ? "cold" : "resident",
  };
  return {
    async work(file: string): Promise<void> {
      const cold = opts.scenario === "cold-start";
      const session = await (cold ? opts.createSession(policy, opts.metrics)
        : resident ??= Promise.resolve(opts.createSession(policy, opts.metrics)));
      const run = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => opts.metrics
        ? opts.metrics.tracer.run(stage, fn) : fn();
      try {
        const ingested = await run("ingest", () => session.ingest(file));
        const prepared = await run("preparation", () => session.prepare(ingested));
        await run("render", () => session.render(prepared));
      } finally { if (cold) await session.close?.(); }
    },
    // Kept for the batch-work interface; real reports use observed events, not these synthetic counters.
    stats: (): BenchWorkStats => ({ modelLoads: 0, cacheHits: 0 }),
    async close(): Promise<void> {
      const prior = resident;
      resident = undefined;
      if (prior) await (await prior).close?.();
    },
  };
}

export type RealBenchmarkMedia = { path: string; sha256: string; durationSeconds: number; bytes: number };
export type RealBenchmarkReport = {
  kind: "real";
  caseId: string;
  scenario: BenchmarkScenario;
  sha: string;
  config: Record<string, unknown>;
  media: readonly RealBenchmarkMedia[];
  machine: HardwareInfo & { hostname: string; release: string; cpuModel: string; node: string };
  operations: { operationId: string; file: string; metricsPath: string; elapsedMs: number; pipelineReadyMs: number | null; firstUsableAssemblyMs: number | null; error?: string; persistenceErrors: number }[];
  elapsedMs: number;
  processingElapsedMs: number;
  mediaMinutesPerProcessingMinute: number;
  latency: { n: number; p50Ms: number; p95Ms: number | null; minimumP95Samples: number };
};

export async function runRealBenchmark(opts: {
  caseId: string;
  scenario: BenchmarkScenario;
  files: readonly string[];
  limit?: number;
  sha: string;
  config: Record<string, unknown>;
  media: readonly RealBenchmarkMedia[];
  outputDir: string;
  createSession: RealSessionFactory;
  /** Must verify the timeline is open in the editor and ready for review. */
  verifyUsable?: (file: string) => Promise<void> | void;
}): Promise<RealBenchmarkReport> {
  // P5 and disk admission must land before testing concurrency 2.
  if ((opts.limit ?? 1) !== 1) throw new Error("real benchmark currently requires concurrency 1");
  for (const file of opts.files) {
    const media = opts.media.find(entry => entry.path === file);
    if (!media || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || !/^[a-f\d]{64}$/i.test(media.sha256)
      || !Number.isSafeInteger(media.bytes) || media.bytes <= 0) throw new Error(`missing real media metadata: ${file}`);
  }
  await mkdir(opts.outputDir, { recursive: true });
  const machine = { ...defaultHardware(), hostname: hostname(), release: release(), cpuModel: cpus()[0]?.model ?? "unknown", node: process.version };
  const operations: RealBenchmarkReport["operations"] = [];
  const started = Date.now();
  // Serial execution lets a resident session forward events into the current file's journal.
  let active!: OperationMetrics;
  const telemetry = new Proxy({} as OperationMetrics, {
    get(_target, property) {
      const value = Reflect.get(active, property);
      return typeof value === "function" ? value.bind(active) : value;
    },
  });
  const work = createRealScenarioWork({ scenario: opts.scenario, metrics: telemetry, createSession: opts.createSession });
  try {
    for (const [index, file] of opts.files.entries()) {
      const metrics = createOperationMetrics({ dir: join(opts.outputDir, "operations"), metadata: { sha: opts.sha, config: opts.config, scenario: opts.scenario, media: opts.media.find(entry => entry.path === file), machine } });
      active = metrics;
      const t0 = Date.now();
      let error: string | undefined;
      let pipelineReadyMs: number | null = null, firstUsableAssemblyMs: number | null = null;
      try {
        await work.work(file);
        pipelineReadyMs = Date.now() - t0;
        if (opts.verifyUsable) {
          await metrics.tracer.run("verify-editor", () => opts.verifyUsable!(file));
          firstUsableAssemblyMs = Date.now() - t0;
        }
      }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      finally {
        try { if (index === opts.files.length - 1) await work.close(); }
        catch (failure) { error ??= failure instanceof Error ? failure.message : String(failure); }
        finally { await metrics.close(); }
      }
      const elapsedMs = Date.now() - t0;
      operations.push({ operationId: metrics.operationId, file, metricsPath: metrics.path, elapsedMs,
        pipelineReadyMs, firstUsableAssemblyMs, ...(error ? { error } : {}), persistenceErrors: metrics.errors });
    }
  } finally { await work.close(); }
  const durations = operations.filter(entry => !entry.error).map(entry => entry.pipelineReadyMs!);
  const elapsedMs = Math.max(1, Date.now() - started);
  const processingElapsedMs = Math.max(1, operations.reduce((total, entry) => total + (entry.pipelineReadyMs ?? entry.elapsedMs), 0));
  const completedSeconds = operations.filter(entry => !entry.error).reduce((seconds, entry) => seconds + opts.media.find(media => media.path === entry.file)!.durationSeconds, 0);
  const report: RealBenchmarkReport = {
    kind: "real", caseId: opts.caseId, scenario: opts.scenario, sha: opts.sha, config: opts.config, media: opts.media, machine, operations, elapsedMs, processingElapsedMs,
    mediaMinutesPerProcessingMinute: completedSeconds / (processingElapsedMs / 1000),
    latency: { n: durations.length, p50Ms: percentile(durations, 0.5), p95Ms: durations.length >= 20 ? percentile(durations, 0.95) : null, minimumP95Samples: 20 },
  };
  await writeFile(join(opts.outputDir, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(opts.outputDir, "report.md"), [
    `# Real benchmark ${opts.caseId}`, `SHA: ${opts.sha}`, `Scenario: ${opts.scenario} · concurrency: 1`,
    `Machine: ${JSON.stringify(machine)}`, `Config: ${JSON.stringify(opts.config)}`, `Media: ${JSON.stringify(opts.media)}`,
    `Media minutes / processing minute: ${report.mediaMinutesPerProcessingMinute.toFixed(3)} (backend ${processingElapsedMs} ms; wall including editor verification ${elapsedMs} ms)`,
    `p50: ${report.latency.p50Ms} ms · p95: ${report.latency.p95Ms ?? "insufficient sample (requires >=20)"} (n=${durations.length})`,
    "Pipeline ready measures render/publish completion. First usable assembly requires verifyUsable to confirm the timeline is open in the editor; null means unverified.",
    "Resources: sampled process tree, shared across overlapping operations; short-lived children may be missed. Physical model loads are unknown; speech progress reports acquisition including reuse.",
    ...operations.map(entry => `- ${entry.operationId}: ${entry.error ?? `${entry.pipelineReadyMs} ms pipeline ready; editor usable: ${entry.firstUsableAssemblyMs === null ? "unverified" : `${entry.firstUsableAssemblyMs} ms`}`} · journal: ${entry.metricsPath} · persistence errors: ${entry.persistenceErrors}`), "",
  ].join("\n"));
  return report;
}
