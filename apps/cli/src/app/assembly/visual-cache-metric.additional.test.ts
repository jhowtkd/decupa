import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOperationMetrics, type CacheMetric } from "@decupa/bench";
import type { FileCoordinator } from "@decupa/coordinator";
import type { Executor } from "../pipeline.ts";
import { describeSource, VISUAL_PROMPT } from "./model.ts";
import { fixtureAssembly } from "./fixture.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const source = (dir: string) => ({
  ...fixtureAssembly().sources[0]!,
  path: join(dir, "private-path", "secret-video.mp4"),
  durationSeconds: 3,
});

const frameExecutor: Executor = {
  async run(call) {
    const pattern = call.args.at(-1)!;
    const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
    for (let i = 0; i < Math.ceil(seconds); i += 1) {
      await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

function client(model: string) {
  return {
    model,
    providerKey: "https://private.example/api?key=secret-provider-key",
    async send() {
      return JSON.stringify({ spans: [{ id: "local-0", start: 0, end: 3, text: "private response text", confidence: "observed", tags: [] }] });
    },
  };
}

it("journals built and hit per window, hashes model/profile identity, and keeps the JSONL private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-cache-metric-"));
  dirs.push(dir);
  const metrics = createOperationMetrics({ dir: join(dir, ".decupa", "metrics") });
  const events: CacheMetric[] = [];
  const onCacheMetric = (event: CacheMetric) => { events.push(event); metrics.emit("cache", event); };
  const input = source(dir);
  const run = (visualClient: ReturnType<typeof client>, profile: "baseline" | "compact" = "baseline") =>
    describeSource(input, dir, new AbortController().signal, { client: visualClient, exec: frameExecutor, profile, onCacheMetric });

  await run(client("model-one"));
  await run(client("model-one"));
  await run(client("model-two"));
  await run(client("model-one"), "compact");
  await metrics.close();

  expect(events.map(event => event.outcome)).toEqual(["built", "hit", "built", "built"]);
  expect(events.every(event => event.stage === "visual" && event.sha256 === input.sha256 && event.configKey && /^[a-f0-9]{64}$/.test(event.configKey))).toBe(true);
  expect(events[0]!.configKey).toBe(events[1]!.configKey);
  expect(events[2]!.configKey).not.toBe(events[0]!.configKey);
  expect(events[3]!.configKey).not.toBe(events[0]!.configKey);
  expect(events.every(event => event.durationMs >= 0)).toBe(true);

  const journal = await readFile(metrics.path, "utf8");
  expect(journal).toContain('"atMs":');
  expect(journal).toContain('"kind":"cache"');
  for (const privateValue of [input.path, "private.example", "secret-provider-key", "private response text", VISUAL_PROMPT]) {
    expect(journal).not.toContain(privateValue);
  }
});

it("does not report a partial visual window as built", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-cache-partial-metric-"));
  dirs.push(dir);
  const events: CacheMetric[] = [];
  const partialClient = {
    ...client("partial-model"),
    async send() {
      return JSON.stringify({ spans: [{ id: "local-0", start: 0, end: 1, text: "partial", confidence: "observed", tags: [] }] });
    },
  };

  const result = await describeSource(source(dir), dir, new AbortController().signal, {
    client: partialClient, exec: frameExecutor, onCacheMetric: event => events.push(event),
  });
  expect(result).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stage: "visual", outcome: "error", configKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it("measures visual work time without coordinator slot waits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-cache-work-duration-"));
  dirs.push(dir);
  let clock = 0;
  const coordinator = {
    async withSlot<T>(_opts: unknown, fn: () => Promise<T> | T): Promise<T> {
      clock += 1000;
      return fn();
    },
  } as unknown as FileCoordinator;
  const timedExecutor: Executor = {
    async run(call) {
      clock += 10;
      const pattern = call.args.at(-1)!;
      const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
      for (let i = 0; i < Math.ceil(seconds); i += 1) {
        await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const timedClient = {
    ...client("timed-model"),
    async send() {
      clock += 20;
      return JSON.stringify({ spans: [{ id: "local-0", start: 0, end: 3, text: "description", confidence: "observed", tags: [] }] });
    },
  };
  const events: CacheMetric[] = [];
  const visualDurations: number[] = [];

  await describeSource(source(dir), dir, new AbortController().signal, {
    client: timedClient,
    exec: timedExecutor,
    coordinator,
    now: () => clock,
    onCacheMetric: event => events.push(event),
    onMetric: metric => { if (metric.phase === "total") visualDurations.push(metric.elapsedMs); },
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stage: "visual", outcome: "built", durationMs: 30 });
  expect(visualDurations[0]).toBeGreaterThanOrEqual(2000);
});
