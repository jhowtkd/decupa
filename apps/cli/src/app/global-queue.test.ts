import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCoordinator } from "@decupa/coordinator";
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

it("export de MP4 passa pela fila global sem mudar o estágio do job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-global-queue-export-"));
  // Fonte, manifesto e plano antes da subida, como numa sessão real: o export
  // confere a fonte contra o manifesto.
  await writeFile(join(dir, "v.mp4"), "não é vídeo", "utf8");
  const { size, mtimeMs } = await stat(join(dir, "v.mp4"));
  await writeFile(join(dir, "source.json"), JSON.stringify({ path: join(dir, "v.mp4"), size, mtimeMs }), "utf8");
  await mkdir(join(dir, "out"), { recursive: true });
  await writeFile(join(dir, "out", "speech_index.json"), JSON.stringify({ units: [{ id: "u001", index: 0, text: "t0" }] }), "utf8");
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
    source_duration: 30, output_duration: 20, clips: [{ unit_ids: ["u001"], start: 10, end: 30 }], joins: [],
  }), "utf8");
  const renders: string[] = [];
  const executor: Executor = { run: async (call) => {
    if (call.args.includes("render")) renders.push(call.args.at(-1)!);
    return { code: 0, stdout: "", stderr: "" };
  } };
  const app = await startApp({
    input: join(dir, "v.mp4"), port: 0, autoStart: false, executor, workDir: dir,
    coordinatorDir: join(dir, "coordinator"),
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const stage = async () => ((await (await fetch(`${base}/jobs/${app.jobId}`)).json()) as { stage: string }).stage;
    const before = await stage();
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/jobs/${app.jobId}/export`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "mp4" }),
      });
      expect(res.status).toBe(200);
    }
    // A fila não memoriza: o segundo export renderiza de novo.
    expect(renders).toHaveLength(2);
    expect(await stage()).toBe(before);
  } finally {
    await app.close();
  }
});

it("export de MP4 congela o plano antes de esperar a fila global", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-global-queue-export-plan-"));
  const video = join(dir, "video.mp4");
  await writeFile(video, "fake video");
  const source = await stat(video);
  await writeFile(join(dir, "source.json"), JSON.stringify({ path: video, size: source.size, mtimeMs: source.mtimeMs }));
  await mkdir(join(dir, "out"), { recursive: true });
  await writeFile(join(dir, "transcript.json"), JSON.stringify({ segments: [] }));
  await writeFile(join(dir, "out", "speech_index.json"), JSON.stringify({ units: [
    { id: "u001", index: 0, start: 0, end: 1, duration: 1, text: "um" },
    { id: "u002", index: 1, start: 1, end: 2, duration: 1, text: "dois" },
  ] }));
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
    source_duration: 2, output_duration: 2,
    clips: [{ unit_ids: ["u001", "u002"], start: 0, end: 2 }], joins: [],
  }));

  const renderedPlans: string[] = [];
  const executor: Executor = { run: async (call) => {
    if (call.args.includes("plan")) {
      const start = call.args.indexOf("--keep") + 1;
      const end = call.args.findIndex((arg) => arg.startsWith("--drop"));
      await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
        source_duration: 2, output_duration: 1,
        clips: [{ unit_ids: call.args.slice(start, end), start: 0, end: 1 }], joins: [],
      }));
    }
    if (call.args.includes("render")) {
      const plan = JSON.parse(await readFile(join(call.env?.CLAUDE_PROJECT_DIR ?? "", "out", "condense_plan.json"), "utf8")) as {
        clips: { unit_ids: string[] }[];
      };
      renderedPlans.push(plan.clips.flatMap((clip) => clip.unit_ids).join(","));
    }
    return { code: 0, stdout: "", stderr: "" };
  } };
  const coordinatorDir = join(dir, "coordinator");
  const app = await startApp({ input: video, workDir: dir, executor, autoStart: false, port: 0, coordinatorDir });
  const other = createFileCoordinator(coordinatorDir, { limit: 1 });
  let release!: () => void;
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = other.withSlot({ stage: "rendering" }, () => new Promise<void>((resolve) => {
    acquired();
    release = resolve;
  }));
  await acquiredPromise;
  const base = `http://127.0.0.1:${app.port}/jobs/${app.jobId}`;
  const post = (route: string, body: object) => fetch(base + route, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const exportRequest = post("/export", { kind: "mp4", keepList: "u001" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await post("/keep", { keepList: "u002" })).status).toBe(200);
  release();
  await holder;
  try {
    expect((await exportRequest).status).toBe(200);
    expect(renderedPlans).toEqual(["u001"]);
  } finally {
    await app.close();
  }
});
