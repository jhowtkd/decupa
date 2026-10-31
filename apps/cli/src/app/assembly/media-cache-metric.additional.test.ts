import { getEventListeners } from "node:events";
import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hashFile, probe } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { type ExecCall, type Executor } from "../pipeline.ts";
import { ensurePlayback } from "./media.ts";
import type { Source } from "./types.ts";
import type { CacheMetric } from "@decupa/bench";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function sourceFrom(path: string): Promise<Source> {
  const info = await probe(path);
  const file = await stat(path);
  return {
    id: "metric-source", path, name: "private source label", sha256: await hashFile(path),
    durationSeconds: Math.max(info.durationMs / 1000, 0.001), hasVideo: info.hasVideo, hasAudio: info.hasAudio,
    size: file.size, mtimeMs: file.mtimeMs,
  } as Source;
}

function copyingExecutor(): Executor {
  return {
    async run(call: ExecCall) {
      const output = call.args.at(-1)!;
      if (output.endsWith(".tmp.mp4")) await copyFile(join(FIXTURES, "clip.mp4"), output);
      else if (output.endsWith(".tmp.jpg")) await writeFile(output, "thumbnail");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("reports privacy-safe proxy identity and build/hit outcomes, without letting a callback failure break playback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-cache-metric-"));
  dirs.push(dir);
  const sourcePath = join(dir, "user-private-name.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), sourcePath);
  const source = await sourceFrom(sourcePath);
  const events: CacheMetric[] = [];
  const opts = { onCacheMetric(event: CacheMetric) { events.push(event); throw new Error("metrics unavailable"); } };

  const first = await ensurePlayback(source, dir, copyingExecutor(), opts);
  const second = await ensurePlayback(source, dir, copyingExecutor(), opts);

  expect(second).toEqual(first);
  expect(events.map(event => event.outcome)).toEqual(["built", "hit"]);
  expect(events).toEqual(events.map(() => expect.objectContaining({
    stage: "proxy",
    sha256: source.sha256,
    configKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    durationMs: expect.any(Number),
  })));
  expect(events.every(event => event.durationMs >= 0)).toBe(true);
  expect(events[0]!.configKey).toBe(events[1]!.configKey);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(dir);
  expect(serialized).not.toContain("private source label");
  expect(serialized).not.toContain(sourcePath);
});

it("reports proxy failures as errors and preserves the original rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-cache-error-metric-"));
  dirs.push(dir);
  const sourcePath = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), sourcePath);
  const source = await sourceFrom(sourcePath);
  const events: CacheMetric[] = [];
  const failing: Executor = { async run() { return { code: 1, stdout: "", stderr: "encoder failed" }; } };

  await expect(ensurePlayback(source, dir, failing, { onCacheMetric: event => events.push(event) })).rejects.toThrow(/proxy falhou/);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ stage: "proxy", sha256: source.sha256, outcome: "error", configKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
});

it("reports a concurrent proxy follower as hit-or-shared while building the proxy once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-cache-single-flight-metric-"));
  dirs.push(dir);
  const sourcePath = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), sourcePath);
  const source = await sourceFrom(sourcePath);
  const buildStarted = deferred<void>();
  const releaseBuild = deferred<void>();
  const events: CacheMetric[] = [];
  let proxyBuilds = 0;
  const exec: Executor = {
    async run(call) {
      const output = call.args.at(-1)!;
      if (output.endsWith(".tmp.mp4")) {
        proxyBuilds += 1;
        buildStarted.resolve();
        await releaseBuild.promise;
        await copyFile(join(FIXTURES, "clip.mp4"), output);
      } else if (output.endsWith(".tmp.jpg")) await writeFile(output, "thumbnail");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const options = { onCacheMetric: (event: CacheMetric) => events.push(event) };

  const first = ensurePlayback(source, dir, exec, options);
  await buildStarted.promise;
  const followerSignal = new AbortController().signal;
  const follower = ensurePlayback(source, dir, exec, { ...options, signal: followerSignal });
  const settled = Promise.all([first, follower]);
  try {
    // O primeiro check do seguidor corre fora do single-flight: liberar antes faria o outcome depender do rename.
    await vi.waitFor(() => {
      expect(getEventListeners(followerSignal, "abort").length, "seguidor não entrou no single-flight do proxy").toBeGreaterThan(0);
    }, { timeout: 30_000, interval: 5 });
  } finally {
    releaseBuild.resolve();
    await settled.catch(() => undefined);
  }
  const results = await settled;

  expect(results[1]).toEqual(results[0]);
  expect(proxyBuilds).toBe(1);
  expect(events.map(event => event.outcome).sort()).toEqual(["built", "hit-or-shared"]);
});
