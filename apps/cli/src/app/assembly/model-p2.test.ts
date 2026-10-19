import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Executor } from "../pipeline.ts";
import { describeSource } from "./model.ts";
import { fixtureAssembly } from "./fixture.ts";

const TEST_CLIENT = { model: "p2-test", providerKey: "p2-test-key" };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function source(durationSeconds: number) {
  return { ...fixtureAssembly().sources[0]!, durationSeconds };
}

function fakeFrameExecutor(onFrames?: (count: number) => void): Executor {
  return {
    async run(call) {
      const pattern = call.args[call.args.length - 1]!;
      const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
      const count = Math.ceil(seconds);
      for (let i = 0; i < count; i += 1) {
        await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), "fake-jpeg");
      }
      onFrames?.(count);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

it.each([60, 600])("aborts a %i-window source while retaining only the configured windows", async (windowCount) => {
  for (const windowLimit of [2, 3, 4]) {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-p2-abort-"));
  const controller = new AbortController();
  const started = deferred();
  const configuredLimitExtracted = deferred();
  let extractedWindows = 0;
  let extractedFrames = 0;
  let requests = 0;
  const client = {
    ...TEST_CLIENT,
    async send(content: unknown[]) {
      requests += 1;
      const frameCount = content.filter((part: any) => part.type === "image_url").length;
      expect(frameCount).toBeGreaterThan(0);
      started.resolve();
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("cancelled client");
    },
  };
  const exec = fakeFrameExecutor((count) => {
    extractedWindows += 1;
    extractedFrames += count;
    if (extractedWindows === windowLimit) configuredLimitExtracted.resolve();
  });
  const run = describeSource(source(windowCount * 20), dir, controller.signal, {
    client,
    exec,
    windowLimit,
  });
  try {
    await started.promise;
    await configuredLimitExtracted.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extractedWindows).toBe(windowLimit);
    expect(extractedFrames).toBeLessThanOrEqual(21 * windowLimit);
    expect(extractedFrames).toBe(21 * windowLimit - 1);
    const blockedFrameCount = extractedFrames;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extractedFrames).toBe(blockedFrameCount);
  } finally {
    controller.abort();
    await expect(run).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  }
  expect(requests).toBeLessThanOrEqual(2);
  }
});

it("matches serial and limited 1fps output, seeks and timestamp payloads on fractional duration", async () => {
  const dirs: string[] = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "assembly-model-p2-frac-"));
    dirs.push(dir);
    return dir;
  };
  const runProfile = async (windowLimit: number) => {
    const dir = await makeDir();
    const seeks: string[] = [];
    const payloads: string[] = [];
    const exec: Executor = {
      async run(call) {
        seeks.push(call.args[call.args.indexOf("-ss") + 1]!);
        const pattern = call.args[call.args.length - 1]!;
        const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
        for (let i = 0; i < Math.ceil(seconds); i += 1) {
          await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const client = {
      ...TEST_CLIENT,
      async send(content: unknown[]) {
        const prompt = content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        payloads.push(prompt + "\n" + content.filter((part: any) => part.type === "image_url").length);
        const match = /na fonte: \[([\d.]+), ([\d.]+)\)/.exec(prompt)!;
        const start = Number(match[1]);
        const end = Number(match[2]);
        const fetchStart = start === 0 ? 0 : start - 1;
        return JSON.stringify({ spans: [{ id: `local-${start}`, start: 0, end: end - fetchStart, text: `janela-${start}`, confidence: "observed", tags: [] }] });
      },
    };
    const spans = await describeSource(source(40.4), dir, new AbortController().signal, { client, exec, windowLimit });
    return { spans, seeks, payloads };
  };
  try {
    const serial = await runProfile(1);
    const limited = await runProfile(4);
    expect(limited.spans).toEqual(serial.spans);
    expect(limited.seeks.slice().sort((a, b) => Number(a) - Number(b))).toEqual(["0", "19", "39"]);
    expect(limited.payloads.slice().sort()).toEqual(serial.payloads.slice().sort());
    expect(limited.spans.at(-1)?.end).toBeCloseTo(40.4, 9);
    expect(limited.payloads.join("\n")).toContain("FRAME fonte=");
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

it("reuses valid window cache without encoding frames or calling the client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-model-p2-cache-"));
  let encodes = 0;
  let requests = 0;
  const client = {
    ...TEST_CLIENT,
    async send() {
      requests += 1;
      return JSON.stringify({ spans: [{ id: "local-0", start: 0, end: 3, text: "mesa", confidence: "observed", tags: [] }] });
    },
  };
  const exec = fakeFrameExecutor(() => { encodes += 1; });
  try {
    const first = await describeSource(source(3), dir, new AbortController().signal, { client, exec, windowLimit: 2 });
    expect(encodes).toBe(1);
    expect(requests).toBe(1);
    encodes = 0;
    requests = 0;
    const cached = await describeSource(source(3), dir, new AbortController().signal, { client, exec, windowLimit: 2 });
    expect(cached).toEqual(first);
    expect(encodes).toBe(0);
    expect(requests).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
