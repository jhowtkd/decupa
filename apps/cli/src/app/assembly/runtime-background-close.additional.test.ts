import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechWorkerRequest } from "@decupa/transcript";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, loadProject } from "./store.ts";
import type { Project, Source } from "./types.ts";

const metricsCloseGate = vi.hoisted(() => ({
  operation: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  finished: undefined as (() => void) | undefined,
}));

vi.mock("@decupa/bench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@decupa/bench")>();
  return {
    ...actual,
    createOperationMetrics(opts: Parameters<typeof actual.createOperationMetrics>[0]) {
      const metrics = actual.createOperationMetrics(opts);
      if (opts.metadata?.operation !== metricsCloseGate.operation) return metrics;
      return {
        ...metrics,
        async close() {
          metricsCloseGate.entered?.();
          await metricsCloseGate.release;
          await metrics.close();
          metricsCloseGate.finished?.();
        },
      };
    },
  };
});

const tempDirs: string[] = [];
const activeApps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  metricsCloseGate.operation = undefined;
  metricsCloseGate.entered = undefined;
  metricsCloseGate.release = undefined;
  metricsCloseGate.finished = undefined;
  await Promise.all(activeApps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function indexingExec(): Executor {
  return { async run() { return { code: 0, stdout: "ok", stderr: "" }; } };
}

async function seedPendingCorrection(options: {
  speech: NonNullable<Parameters<typeof startApp>[0]["speech"]>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "assembly-runtime-close-align-"));
  tempDirs.push(dir);
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const source: Source = { ...fixtureAssembly().sources[0]!, path: clip, hasVideo: false };
  const project = blankProject("align-close");
  project.assembly.sources = [source];
  project.corrections = [{
    id: "corr-pending", sourceId: source.id, start: 0, end: 0.5,
    text: "fala nova", status: "pending", words: [],
  }];
  await createProject(dir, project as Project);
  const app = await startApp({ projectDir: dir, port: 0, executor: indexingExec(), speech: options.speech });
  activeApps.push(app);
  return { base: `http://127.0.0.1:${app.port}`, dir };
}

it("close aborta e aguarda alinhamento em worker, preservando a correção pending", async () => {
  let signalWorker!: () => void;
  let releaseWorker!: () => void;
  const workerEntered = new Promise<void>((resolve) => { signalWorker = resolve; });
  const workerBlocked = new Promise<void>((resolve) => { releaseWorker = resolve; });
  let request: SpeechWorkerRequest | undefined;
  const appState = await seedPendingCorrection({
    speech: {
      worker: async (req) => {
        request = req;
        signalWorker();
        await workerBlocked;
        return {
          language: "pt",
          words: [
            { text: "fala", startMs: 100, endMs: 250, confidence: 0.9, sentenceIndex: 0 },
            { text: "nova", startMs: 260, endMs: 430, confidence: 0.9, sentenceIndex: 0 },
          ],
          unaligned: [],
        };
      },
      extract: async () => undefined,
      detectSilence: async () => [],
    },
  });
  try {
    await fetch(`${appState.base}/project`);
    await workerEntered;

    let closeFinished = false;
    const closing = activeApps.at(-1)!.close().then(() => { closeFinished = true; });
    await vi.waitFor(() => expect(request?.signal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closeFinishedWhileWorkerBlocked = closeFinished;
    releaseWorker();
    await closing;

    expect(closeFinishedWhileWorkerBlocked).toBe(false);
    expect((await loadProject(appState.dir)).corrections[0]?.status).toBe("pending");
    await rm(appState.dir, { recursive: true, force: true });
    await expect(stat(appState.dir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    releaseWorker();
  }
});

it("close aguarda o flush do journal de preparação iniciado por POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-runtime-close-prepare-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await createProject(dir, blankProject("prepare-close"));
  let signalClose!: () => void;
  let releaseClose!: () => void;
  let signalFinished!: () => void;
  const closeEntered = new Promise<void>((resolve) => { signalClose = resolve; });
  const closeBlocked = new Promise<void>((resolve) => { releaseClose = resolve; });
  const closeFinished = new Promise<void>((resolve) => { signalFinished = resolve; });
  metricsCloseGate.operation = "prepare";
  metricsCloseGate.entered = signalClose;
  metricsCloseGate.release = closeBlocked;
  metricsCloseGate.finished = signalFinished;
  const app = await startApp({
    projectDir: dir,
    port: 0,
    executor: indexingExec(),
    allowPaidModel: true,
    proposeSend: async () => JSON.stringify({ scenes: [], changedSceneIds: [], gaps: [] }),
  });
  activeApps.push(app);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const current = await (await fetch(`${base}/project`)).json() as { project: { revision: number } };
    const response = await fetch(`${base}/project/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: current.project.revision, request: "", modelOptIn: true }),
    });
    expect(response.status).toBe(202);
    await closeEntered;

    let finishedWhileJournalBlocked = false;
    const closing = activeApps.at(-1)!.close().then(() => { finishedWhileJournalBlocked = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closeWaitedForJournal = !finishedWhileJournalBlocked;
    releaseClose();
    await closeFinished;
    await closing;

    const metricsDir = join(dir, ".decupa", "metrics");
    const journals = await readdir(metricsDir);
    const journal = journals.find((name) => name.endsWith(".jsonl"));
    expect(journal).toBeTruthy();
    expect(await readFile(join(metricsDir, journal!), "utf8")).toContain('"kind":"operation-finished"');
    expect(closeWaitedForJournal).toBe(true);
    await rm(dir, { recursive: true, force: true });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    releaseClose();
  }
});
