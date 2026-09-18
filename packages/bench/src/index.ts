import { createHash } from "node:crypto";
import { cpus, platform, totalmem } from "node:os";
import type { FileCoordinator } from "@decupa/coordinator";
import { createLimitedQueue } from "@decupa/queue";
import { createTracer, type TraceSink } from "@decupa/trace";

export type BenchmarkScenario = "cold-start" | "resident-models" | "cached-artifacts";

export type HardwareInfo = {
  cpus: number;
  ramMb: number;
  platform: string;
};

export type BenchmarkManifest = {
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
};

export type BatchBenchmarkOptions = {
  caseId: string;
  scenario: BenchmarkScenario;
  files: readonly string[];
  limit: number;
  work: (file: string) => Promise<void> | void;
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
    };
  });
}

export function renderBenchmark(manifest: BenchmarkManifest): string {
  return [
    `# benchmark ${manifest.caseId}`,
    `hash: ${manifest.hash}`,
    `scenario: ${manifest.scenario}`,
    `hardware: ${manifest.hardware.cpus} cpus · ${manifest.hardware.ramMb} MiB · ${manifest.hardware.platform}`,
    `batch: ${manifest.batchSize} · sample: ${manifest.sampleSize}`,
    `throughput: ${manifest.throughput.toFixed(3)} /s`,
    `latency p50: ${manifest.latency.p50Ms} ms · p95: ${manifest.latency.p95Ms} ms (n=${manifest.latency.n})`,
    `queue limit ${manifest.queue.limit} peak ${manifest.queue.peak} · processes peak ${manifest.processes.peak}`,
    `ram peak ${manifest.ram.peakMb} MiB`,
    `completed ${manifest.completed} · failures ${manifest.failures}${manifest.failed.length ? ` (${manifest.failed.join(", ")})` : ""}`,
  ].join("\n");
}
