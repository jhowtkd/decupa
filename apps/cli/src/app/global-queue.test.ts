import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Executor } from "./pipeline.ts";
import { startApp } from "./server.ts";
import { jobConcurrency } from "./heavy-work.ts";

it("DECUPA_JOB_CONCURRENCY usa 1 por padrão e aceita concorrência explícita", () => {
  expect(jobConcurrency({})).toBe(1);
  expect(jobConcurrency({ DECUPA_JOB_CONCURRENCY: "3" })).toBe(3);
  expect(() => jobConcurrency({ DECUPA_JOB_CONCURRENCY: "0" })).toThrow(/inteiro/);
});

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  expect(ok(value), JSON.stringify(value)).toBe(true);
  return value;
}

it("duas Limpezas usam uma fila global FIFO para transcrição", async () => {
  const root = await mkdtemp(join(tmpdir(), "decupa-global-queue-"));
  const coordinatorDir = join(root, "config", "coordinator");
  const engine = join(root, "engine");
  await mkdir(join(engine, "mcp", "ve_tools"), { recursive: true });
  await writeFile(join(engine, "mcp", "ve_tools", "condense.py"), "# fake\n");
  await writeFile(join(engine, "mcp", "ve_tools", "condense_lang.py"),
    '_TERMINAL_PUNCT = ".。！？!?…"\nFILLERS_SOFT_PT = []\n');
  const inputA = join(root, "a.mp4");
  const inputB = join(root, "b.mp4");
  await writeFile(inputA, "a");
  await writeFile(inputB, "b");

  let active = 0;
  let maxActive = 0;
  let entered = 0;
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const speech = {
    worker: async (req: { taskId: string; language: string }) => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (entered === 1) await firstReleased;
        return {
          language: req.language,
          words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      } finally {
        active -= 1;
      }
    },
    extract: async () => undefined,
    detectSilence: async () => [],
  };
  const executor: Executor = {
    run: async (call) => {
      if (call.args.includes("index")) {
        const work = call.env?.CLAUDE_PROJECT_DIR;
        if (work) {
          await mkdir(join(work, "out"), { recursive: true });
          await writeFile(join(work, "out", "speech_index.json"), JSON.stringify({
            units: [{ id: "u001", index: 0, start: 0, end: 1, duration: 1, text: "oi" }],
          }));
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const options = {
    port: 0,
    coordinatorDir,
    executor,
    speech,
    env: { VE_PLUGIN_ROOT: engine },
  };
  const previousEngine = process.env.VE_PLUGIN_ROOT;
  process.env.VE_PLUGIN_ROOT = engine;
  const appA = await startApp({ ...options, input: inputA });
  const appB = await startApp({ ...options, input: inputB });
  const job = (app: { port: number; jobId: string }) => async () =>
    await (await fetch(`http://127.0.0.1:${app.port}/jobs/${app.jobId}`)).json() as { stage: string };
  try {
    await eventually(async () => entered, (count) => count >= 1);
    const stateB = await eventually(job(appB), (state) => state.stage === "queued");
    expect(stateB.stage).toBe("queued");
    expect(maxActive).toBe(1);
    releaseFirst();
    await eventually(job(appA), (state) => !["queued", "transcribing"].includes(state.stage));
    await eventually(job(appB), (state) => !["queued", "transcribing"].includes(state.stage));
    expect(maxActive).toBe(1);
    // O cache por conteúdo da fala continua no Projeto; só a fila de trabalho
    // pesado fica compartilhada fora dele.
    await expect(access(join(root, ".decupa-a.mp4", ".decupa", "coordinator"))).resolves.toBeUndefined();
    await expect(access(coordinatorDir)).resolves.toBeUndefined();
    // A fila global não grava tarefas concluídas, portanto não cria o cache
    // persistente que existia no coordinator antigo.
    await expect(access(join(coordinatorDir, "tasks"))).rejects.toThrow();
  } finally {
    releaseFirst();
    await Promise.all([appA.close(), appB.close()]);
    if (previousEngine === undefined) delete process.env.VE_PLUGIN_ROOT;
    else process.env.VE_PLUGIN_ROOT = previousEngine;
  }
});
