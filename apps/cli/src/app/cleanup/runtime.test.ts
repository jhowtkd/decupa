import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTracer } from "@decupa/trace";
import { createCleanupPlanning } from "../../condense/cleanup-planning.ts";
import { JobStore } from "../jobs.ts";
import type { Executor, PipelineJob } from "../pipeline.ts";
import { createCleanupRuntime } from "./routes.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

it("considera notas de cacoetes pendentes trabalho em andamento", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "cleanup-runtime-"));
  dirs.push(workDir);
  const store = new JobStore();
  const job = store.create({ videoPath: join(workDir, "video.mp4"), workDir });
  const pipelineJob: PipelineJob = { id: job.id, videoPath: job.videoPath, workDir, signal: store.signal(job.id)! };
  const exec: Executor = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const cleanup = createCleanupPlanning({
    job: pipelineJob, exec, tracer: createTracer(), store, env: {},
    visual: async () => ({}), flags: async () => ({}),
  });
  const runtime = createCleanupRuntime({
    input: job.videoPath, workDir, visualEnv: {}, exec, pipelineJob, job, store, cleanup,
    ingestAbort: new AbortController(), audioReady: () => false, loadStored: async () => null,
    page: async () => "", replan: async () => {}, triageReply: async () => ({}),
    triageRequestKey: async () => "", otioClipsForPlan: () => [], busy: () => false,
  });

  store.setStage(job.id, "ready");
  store.setFillerNotesPending(job.id, true);
  expect(runtime.isBusy()).toBe(true);
});
