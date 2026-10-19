import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCoordinator } from "@decupa/coordinator";
import { expect, it } from "vitest";
import { runIngest, type Executor } from "./pipeline.ts";
import { createHeavyCoordinator, runHeavy } from "./heavy-work.ts";

it("Projeto na home não usa o mesmo diretório da fila global", async () => {
  const home = await mkdtemp(join(tmpdir(), "decupa-heavy-home-"));
  const workDir = join(home, "work");
  await mkdir(workDir, { recursive: true });
  const video = join(workDir, "fala.mp4");
  await writeFile(video, "fake video");
  const heavy = createHeavyCoordinator({ configDir: home, env: {} });
  const memo = createFileCoordinator(join(home, ".decupa", "coordinator"), { limit: 1, pollMs: 5 });
  const executor: Executor = {
    run: async (call) => {
      if (call.args.includes("index")) {
        await mkdir(join(workDir, "out"), { recursive: true });
        await writeFile(join(workDir, "out", "speech_index.json"), JSON.stringify({ units: [] }));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const controller = new AbortController();
  let workerCalled = false;
  const promise = runIngest(
    { id: "job", videoPath: video, workDir },
    executor,
    () => {},
    undefined,
    undefined,
    {
      coordinator: memo,
      worker: async () => {
        workerCalled = true;
        return { language: "pt", words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }], unaligned: [] };
      },
      extract: async () => {},
      detectSilence: async () => [],
    },
    controller.signal,
    { coordinator: heavy, visual: false },
  );
  const outcome = await Promise.race([
    promise.then(() => "done", () => "error"),
    // O travamento que este teste pega é infinito; 10 s só dá folga ao disco
    // lento do runner Windows, onde dois coordinators em arquivo passam de 500 ms.
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  if (outcome === "timeout") controller.abort();
  await promise.catch(() => undefined);
  expect(outcome).toBe("done");
  expect(workerCalled).toBe(true);
});

it("processos CLI locais compartilham o limite de CPU configurado", async () => {
  const home = await mkdtemp(join(tmpdir(), "decupa-heavy-limit-"));
  const first = createHeavyCoordinator({ configDir: home, env: { DECUPA_JOB_CONCURRENCY: "1" } });
  const second = createHeavyCoordinator({ configDir: home, env: { DECUPA_JOB_CONCURRENCY: "1" } });
  let active = 0;
  let peak = 0;
  const work = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
  };
  await Promise.all([
    first.withSlot({ stage: "frame-extraction" }, work),
    second.withSlot({ stage: "frame-extraction" }, work),
  ]);
  expect(peak).toBe(1);
});

it("runHeavy prioriza render, mantém outras etapas em lote e respeita override", async () => {
  const seen: Array<{ stage: string; priority?: string }> = [];
  const coordinator = {
    async withSlot<T>(opts: { stage: string; priority?: string }, fn: () => Promise<T> | T) {
      seen.push(opts);
      return fn();
    },
  } as unknown as import("@decupa/coordinator").FileCoordinator;
  await runHeavy(coordinator, { stage: "rendering", build: () => "render" });
  await runHeavy(coordinator, { stage: "visual", build: () => "visual" });
  await runHeavy(coordinator, { stage: "rendering", priority: "batch", build: () => "background render" });
  expect(seen.map(({ stage, priority }) => [stage, priority])).toEqual([
    ["rendering", "interactive"],
    ["visual", "batch"],
    ["rendering", "batch"],
  ]);
});
