import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyzeSource: vi.fn(),
  describeSource: vi.fn(),
  renderAssembly: vi.fn(),
  ensurePlayback: vi.fn(),
  verifySourceIdentity: vi.fn(),
}));

vi.mock("./analysis.ts", () => ({ analyzeSource: mocks.analyzeSource }));
vi.mock("./model.ts", () => ({ describeSource: mocks.describeSource }));
vi.mock("./render.ts", () => ({ renderAssembly: mocks.renderAssembly }));
vi.mock("./media.ts", () => ({
  ensurePlayback: mocks.ensurePlayback,
  verifySourceIdentity: mocks.verifySourceIdentity,
}));

import { createProject, loadProject, saveProject } from "./store.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { runPreparation } from "./preparation.ts";
import type { Analysis, Source } from "./types.ts";

const dirs: string[] = [];

async function makeProject(): Promise<{ dir: string; revision: number }> {
  const dir = await mkdtemp(join(tmpdir(), "prep-metrics-"));
  dirs.push(dir);
  await createProject(dir, blankProject("metrics-test"));
  const video = join(dir, "source.mp4");
  await writeFile(video, "fake video bytes");
  const source: Source = {
    ...fixtureAssembly().sources[0]!,
    id: "source-1",
    path: video,
    sha256: createHash("sha256").update("fake video bytes").digest("hex"),
    name: "source.mp4",
    size: 16,
    mtimeMs: (await (await import("node:fs/promises")).stat(video)).mtimeMs,
  };
  const project = await loadProject(dir);
  await saveProject(dir, project.revision, (current) => ({
    ...current,
    assembly: { ...current.assembly, sources: [source] },
  }));
  return { dir, revision: (await loadProject(dir)).revision };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runPreparation operation metrics", () => {
  it("persists visual metrics and stage events even when the caller callback throws", async () => {
    const { dir, revision } = await makeProject();
    const analysis: Analysis = {
      sourceId: "source-1",
      key: "source-key",
      speech: [{ id: "source-1:u0", sourceId: "source-1", start: 0, end: 1, text: "hello" }],
      visual: [],
      status: "ready",
      words: [],
      wordsStatus: "ready",
      visualCoverage: { requested: [], returned: [], missing: [] },
    };
    mocks.verifySourceIdentity.mockResolvedValue(undefined);
    mocks.analyzeSource.mockResolvedValue(analysis);
    mocks.ensurePlayback.mockResolvedValue({ videoPath: join(dir, "source.mp4") });
    mocks.describeSource.mockImplementation(async (_source: unknown, _dir: string, _signal: AbortSignal, deps: { onMetric?: (metric: unknown) => void }) => {
      deps.onMetric?.({
        sourceId: "source-1", windowStart: 0, windowEnd: 3,
        phase: "request", outcome: "ok", elapsedMs: 7, queueMs: 1, frames: 2, attempt: 1,
      });
      return [{ id: "visual-1", sourceId: "source-1", start: 0, end: 3, text: "person speaking", confidence: "observed", tags: [] }];
    });
    let previewStarts = false;
    mocks.renderAssembly.mockImplementation(async (
      _assembly: unknown, projectDir: string, _exec: unknown, status: { onStarted?: () => void },
    ) => {
      if (previewStarts) status.onStarted?.();
      const path = join(projectDir, "preview-cache", "reference.mp4");
      await mkdir(join(projectDir, "preview-cache"), { recursive: true });
      await writeFile(path, "rendered preview");
      return path;
    });
    const onMetric = vi.fn(() => { throw new Error("telemetry callback failure"); });

    const result = await runPreparation(dir, revision, {
      mode: "prepare", request: "make a cut", modelOptIn: true, visualOptIn: true,
    }, {
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      proposeSend: async () => JSON.stringify({
        scenes: [{ id: "scene-1", objective: "Opening", selections: [{ speechId: "source-1:u0" }] }],
        changedSceneIds: ["scene-1"], gaps: [],
      }),
      describeClient: { model: "test-model", providerKey: "test", send: async () => "{}" },
      onMetric,
    }, { signal: new AbortController().signal, isCurrent: () => true });

    expect(result.preparation?.status).toBe("ready");
    expect(onMetric).toHaveBeenCalledOnce();
    const metricsDir = join(dir, ".decupa", "metrics");
    const [journal] = await readdir(metricsDir);
    const lines = (await readFile(join(metricsDir, journal!), "utf8")).trim().split("\n");
    expect(lines.join("\n")).not.toContain(dir);
    expect(lines.join("\n")).not.toContain("make a cut");
    expect(lines.join("\n")).not.toContain('"text":"hello"');
    expect(lines.join("\n")).not.toContain("person speaking");
    const events = lines.map((line) => {
      const row = JSON.parse(line) as { kind: string; data?: unknown };
      return { kind: row.kind, data: row.data };
    });
    expect(events.some((event) => event.kind === "visual" && JSON.stringify(event.data).includes('"phase":"request"'))).toBe(true);
    expect(events.some((event) => event.kind === "stage")).toBe(true);
    expect(events).toContainEqual({ kind: "cache", data: expect.objectContaining({ stage: "analysis", sourceId: "source-1", outcome: "hit-or-shared", sha256: createHash("sha256").update("fake video bytes").digest("hex"), configKey: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: expect.any(Number) }) });
    expect(events).toContainEqual({ kind: "cache", data: { stage: "preview", outcome: "hit-or-shared" } });
    expect(events.some((event) => event.kind === "operation-finished")).toBe(true);

    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    mocks.analyzeSource.mockImplementation(async (
      _source: unknown, _dir: string, _exec: unknown,
      options: { onStage?: (stage: "queued" | "indexing") => void },
    ) => {
      options.onStage?.("queued");
      clock += 1000;
      options.onStage?.("indexing");
      clock += 30;
      return analysis;
    });
    const builtProject = await makeProject();
    previewStarts = true;
    const built = await runPreparation(builtProject.dir, builtProject.revision, {
      mode: "prepare", request: "make a cut", modelOptIn: true, visualOptIn: true,
    }, {
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      proposeSend: async () => JSON.stringify({
        scenes: [{ id: "scene-1", objective: "Opening", selections: [{ speechId: "source-1:u0" }] }],
        changedSceneIds: ["scene-1"], gaps: [],
      }),
      describeClient: { model: "test-model", providerKey: "test", send: async () => "{}" },
      onMetric: vi.fn(),
    }, { signal: new AbortController().signal, isCurrent: () => true });
    expect(built.preparation?.status, built.preparation?.error).toBe("ready");
    const builtMetricsDir = join(builtProject.dir, ".decupa", "metrics");
    const journals = await Promise.all((await readdir(builtMetricsDir)).map((file) => readFile(join(builtMetricsDir, file), "utf8")));
    const builtEvents = journals.flatMap((journal) => journal.trim().split("\n").map((line) => {
      const row = JSON.parse(line) as { kind: string; data?: unknown };
      return { kind: row.kind, data: row.data };
    }));
    expect(builtEvents).toContainEqual({ kind: "cache", data: expect.objectContaining({ stage: "analysis", sourceId: "source-1", outcome: "built", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), configKey: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: 30 }) });
    expect(builtEvents).toContainEqual({ kind: "cache", data: { stage: "preview", outcome: "built" } });
  });

  it("closes and persists the operation journal when preparation rejects", async () => {
    const { dir, revision } = await makeProject();
    await expect(runPreparation(dir, revision - 1, {
      mode: "preview", request: "", modelOptIn: false, visualOptIn: false,
    }, { exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } }, {
      signal: new AbortController().signal, isCurrent: () => true,
    })).rejects.toThrow(/revisão desatualizada/);

    const [journal] = await readdir(join(dir, ".decupa", "metrics"));
    expect(await readFile(join(dir, ".decupa", "metrics", journal!), "utf8")).toContain('"kind":"operation-finished"');
  });

  it("persists cancelled when the caller signal is already aborted", async () => {
    const { dir, revision } = await makeProject();
    const aborter = new AbortController();
    aborter.abort();

    const result = await runPreparation(dir, revision, {
      mode: "preview", request: "", modelOptIn: false, visualOptIn: false,
    }, { exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } }, {
      signal: aborter.signal, isCurrent: () => true,
    });

    expect(result.preparation?.status).toBe("cancelled");
  });
});
