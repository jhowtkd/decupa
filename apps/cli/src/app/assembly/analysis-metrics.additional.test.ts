import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Analysis, Source } from "./types.ts";

const mocks = vi.hoisted(() => ({ analyzeSource: vi.fn() }));
vi.mock("./analysis.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("./analysis.ts")>()),
  analyzeSource: mocks.analyzeSource,
}));

import { analyzeSourceWithMetrics } from "./analysis-metrics.ts";
import { fixtureAssembly } from "./fixture.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function input(): { source: Source; analysis: Analysis } {
  const fixture = fixtureAssembly();
  const source = fixture.sources[0]!;
  const analysis: Analysis = {
    sourceId: source.id, key: "source-key", speech: [], visual: [], status: "ready",
    words: [], wordsStatus: "ready", visualCoverage: { requested: [], returned: [], missing: [] },
  };
  return { source, analysis };
}

it("preserves stage callbacks and measures only analysis work after the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analysis-metrics-build-"));
  dirs.push(dir);
  const { source, analysis } = input();
  const emit = vi.fn();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  mocks.analyzeSource.mockImplementation(async (_source: Source, _dir: string, _exec: unknown, options: { onStage?: (stage: string) => void }) => {
    options.onStage?.("queued");
    clock += 1000;
    options.onStage?.("indexing");
    clock += 30;
    return analysis;
  });
  const stages: string[] = [];

  await expect(analyzeSourceWithMetrics(source, dir, { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, {
    onStage: stage => stages.push(stage),
  }, { emit })).resolves.toBe(analysis);
  const cacheEvents = emit.mock.calls.filter(([kind]) => kind === "cache").map(([, data]) => data as Record<string, unknown>);
  expect(stages).toEqual(["queued", "indexing"]);
  expect(cacheEvents).toHaveLength(1);
  expect(cacheEvents[0]).toMatchObject({
    stage: "analysis", sha256: source.sha256, configKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    outcome: "built", durationMs: 30,
  });
});

it("records a successful result with no build stage as hit-or-shared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analysis-metrics-hit-"));
  dirs.push(dir);
  const { source, analysis } = input();
  const emit = vi.fn();
  mocks.analyzeSource.mockResolvedValue(analysis);

  await analyzeSourceWithMetrics(source, dir, { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, {}, { emit });
  const cacheEvents = emit.mock.calls.filter(([kind]) => kind === "cache").map(([, data]) => data as Record<string, unknown>);
  expect(cacheEvents).toHaveLength(1);
  expect(cacheEvents[0]).toMatchObject({ stage: "analysis", sha256: source.sha256, outcome: "hit-or-shared" });
});

it("records a queued analysis failure once as error, never as a build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analysis-metrics-error-"));
  dirs.push(dir);
  const { source } = input();
  const emit = vi.fn();
  mocks.analyzeSource.mockImplementation(async (_source: Source, _dir: string, _exec: unknown, options: { onStage?: (stage: string) => void }) => {
    options.onStage?.("queued");
    throw new Error("queue unavailable");
  });

  await expect(analyzeSourceWithMetrics(source, dir, { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, {}, { emit }))
    .rejects.toThrow("queue unavailable");
  const cacheEvents = emit.mock.calls.filter(([kind]) => kind === "cache").map(([, data]) => data as Record<string, unknown>);
  expect(cacheEvents).toHaveLength(1);
  expect(cacheEvents[0]).toMatchObject({ stage: "analysis", sha256: source.sha256, outcome: "error" });
  expect(cacheEvents[0]!.outcome).not.toBe("built");
});
