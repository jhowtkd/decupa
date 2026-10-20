import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { CacheMetric } from "@decupa/bench";
import { hashFile, probe } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { ExecCall, Executor } from "../pipeline.ts";
import { ensurePreviewPlayback } from "./preview-playback.ts";

function copyExecutor(source: string, beforeCopy?: () => void): Executor {
  return {
    async run(call) {
      beforeCopy?.();
      await copyFile(source, call.args.at(-1)!);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "preview-playback-additional-"));
}

const runFile = promisify(execFile);

it("converts tall PCM media to bounded H.264/AAC and records a built cache hit", async () => {
  const dir = await tempDir();
  try {
    const reference = join(dir, "tall-pcm.mkv");
    await runFile("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1.25", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_s16le", "-shortest", reference,
    ]);
    const originalHash = await hashFile(reference);
    const referenceInfo = await probe(reference);
    expect(Math.max(referenceInfo.width ?? 0, referenceInfo.height ?? 0)).toBeGreaterThan(960);
    expect(referenceInfo.audioCodec).toBe("pcm_s16le");

    let conversions = 0;
    const exec: Executor = {
      async run(call: ExecCall) {
        conversions += 1;
        const result = await runFile(call.command, call.args, { signal: call.signal, maxBuffer: 1024 * 1024 });
        return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
      },
    };
    const metrics: CacheMetric[] = [];
    const options = { cacheDir: dir, onCacheMetric: (metric: CacheMetric) => { metrics.push(metric); } };
    const output = await ensurePreviewPlayback(reference, exec, options);
    const cachedOutput = await ensurePreviewPlayback(reference, exec, options);
    const outputInfo = await probe(output);

    expect(cachedOutput).toBe(output);
    expect(conversions).toBe(1);
    expect(outputInfo.videoCodec).toBe("h264");
    expect(outputInfo.audioCodec).toBe("aac");
    expect(Math.max(outputInfo.width ?? 0, outputInfo.height ?? 0)).toBeLessThanOrEqual(960);
    expect(Math.abs(outputInfo.durationMs - referenceInfo.durationMs)).toBeLessThanOrEqual(100);
    expect(await hashFile(reference)).toBe(originalHash);
    expect(metrics.map(metric => metric.outcome)).toEqual(["built", "hit"]);
    expect(metrics.every(metric => metric.stage === "proxy" && metric.configKey !== null
      && /^[a-f\d]{64}$/i.test(metric.configKey))).toBe(true);
    expect(metrics.every(metric => metric.sha256 === originalHash)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reuses a valid content-keyed cache and reconstructs a missing derivative", async () => {
  const dir = await tempDir();
  try {
    const reference = join(dir, "reference.mp4");
    const sameContent = join(dir, "same-content.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), reference);
    await copyFile(reference, sameContent);
    const originalHash = await hashFile(reference);
    const execCalls: string[] = [];
    const exec = copyExecutor(reference, () => execCalls.push("encode"));
    const opts = { cacheDir: dir, sha256: originalHash };

    const first = await ensurePreviewPlayback(reference, exec, opts);
    const second = await ensurePreviewPlayback(sameContent, exec, opts);
    const sha = await hashFile(reference);
    expect(first).toBe(join(dir, `playback-v1-${sha}.mp4`));
    expect(second).toBe(first);
    expect(execCalls).toHaveLength(1);
    expect(await hashFile(reference)).toBe(originalHash);
    expect(await hashFile(sameContent)).toBe(originalHash);
    const info = await probe(first);
    expect(info.videoCodec).toBe("h264");
    expect(info.audioCodec).toBe("aac");
    expect(Math.max(info.width ?? 0, info.height ?? 0)).toBeLessThanOrEqual(960);

    await rm(first);
    const rebuilt = await ensurePreviewPlayback(reference, exec, opts);
    expect(rebuilt).toBe(first);
    expect(execCalls).toHaveLength(2);
    expect(await stat(rebuilt)).toBeTruthy();
    expect(await hashFile(reference)).toBe(originalHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("deduplicates concurrent requests for the same reference content", async () => {
  const dir = await tempDir();
  try {
    const reference = join(dir, "reference.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), reference);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const exec: Executor = {
      async run(call) {
        calls += 1;
        await gate;
        await copyFile(reference, call.args.at(-1)!);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const first = ensurePreviewPlayback(reference, exec, { cacheDir: dir });
    const second = ensurePreviewPlayback(reference, exec, { cacheDir: dir });
    await viWaitForCalls(() => calls);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not publish a derivative when preparation is cancelled", async () => {
  const dir = await tempDir();
  try {
    const reference = join(dir, "reference.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), reference);
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const exec: Executor = {
      async run(_call) {
        entered();
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const pending = ensurePreviewPlayback(reference, exec, { cacheDir: dir, signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect((await readdir(dir)).filter(name => name.startsWith("playback-v1-")).sort()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects corrupt encoded output and leaves the content cache empty", async () => {
  const dir = await tempDir();
  try {
    const reference = join(dir, "reference.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), reference);
    const exec: Executor = {
      async run(call) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(call.args.at(-1)!, "not a media file");
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(ensurePreviewPlayback(reference, exec, { cacheDir: dir })).rejects.toThrow();
    expect((await readdir(dir)).filter(name => name.startsWith("playback-v1-")).sort()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function viWaitForCalls(read: () => number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (read() === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(read()).toBeGreaterThan(0);
}
