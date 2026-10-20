import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { createAssemblyRuntime, blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, saveProject } from "./store.ts";
import { confirmProjectCleanup, planProjectCleanup } from "../project-cleanup.ts";
import { initializeResourceLedger } from "../resource-ledger.ts";

const streams = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("../../http/media.ts", () => ({
  serveMedia: async (_req: unknown, res: ServerResponse, path: string) => {
    streams.paths.push(path);
    res.writeHead(200);
    res.end("preview streamed");
  },
}));

const now = 40 * 86_400_000;

async function fixture(executor: Executor) {
  const root = await mkdtemp(join(tmpdir(), "preview-playback-cleanup-"));
  const projectsRoot = join(root, "projects");
  const dir = join(projectsRoot, "one");
  const sourcePath = join(dir, "imports", "source.mp4");
  const reference = join(dir, "rev-1", "reference.mp4");
  await mkdir(join(dir, "imports"), { recursive: true });
  await mkdir(join(dir, "rev-1"), { recursive: true });
  await copyFile(join(FIXTURES, "clip.mp4"), sourcePath);
  await copyFile(sourcePath, reference);
  const sha256 = await hashFile(sourcePath);
  const assembly = fixtureAssembly();
  const source = { ...assembly.sources[0]!, sha256, path: sourcePath };
  assembly.sources = [source];
  assembly.tracks[1]!.clips = [];
  const project = blankProject("one");
  project.revision = 1;
  project.assembly = { ...assembly, revision: 1 };
  project.previewRevision = 1;
  project.finalApprovedRevision = 1;
  project.lifecycle = { state: "entregue", revision: 1, enteredAt: { entregue: now - 8 * 86_400_000 } };
  project.previewArtifact = {
    revision: 1,
    relativePath: "rev-1/reference.mp4",
    sha256: await hashFile(reference),
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
  };
  const ledger = await initializeResourceLedger({ root, projectsRoot, now: () => now, env: {} });
  await createProject(dir, project);
  const runtime = createAssemblyRuntime(dir, { exec: executor, port: () => 0 });
  const server = createServer((req, res) => {
    void runtime.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  return {
    root, dir, sourcePath, reference, sha256, ledger, runtime, server,
    base: `http://127.0.0.1:${address.port}`,
    cleanupOptions: { ledger, now: () => now, env: {} },
    async close() {
      await runtime.close();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function confirmCleanup(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await planProjectCleanup(f.dir, f.cleanupOptions);
  expect(plan.eligible).toBe(true);
  await confirmProjectCleanup(f.dir, { planId: plan.planId, confirmed: true, acknowledgeOffline: true }, f.cleanupOptions);
}

it("serves a registered revision after cleanup releases its source media", async () => {
  streams.paths.length = 0;
  const f = await fixture({ run: async call => {
    await copyFile(f.reference, call.args.at(-1)!);
    return { code: 0, stdout: "", stderr: "" };
  } });
  try {
    const originalHash = await hashFile(f.reference);
    await confirmCleanup(f);
    await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    const response = await fetch(`${f.base}/project/preview/1`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toBe("preview streamed");
    expect(streams.paths).toHaveLength(1);
    expect(streams.paths[0]).toMatch(/rev-1\/playback-v1-[a-f0-9]{64}\.mp4$/);
    expect(await hashFile(f.reference)).toBe(originalHash);
  } finally {
    await f.close();
  }
});

it("close aborts and waits for preview encoding, removes partial output, and closes its journal", async () => {
  streams.paths.length = 0;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let aborted!: () => void;
  const abortSeen = new Promise<void>(resolve => { aborted = resolve; });
  let finishExec!: () => void;
  const execFinished = new Promise<void>(resolve => { finishExec = resolve; });
  let execSettled = false;
  let tempPath = "";
  const f = await fixture({
    async run(call) {
      tempPath = call.args.at(-1)!;
      await writeFile(tempPath, "partial mp4");
      entered();
      await new Promise<void>(resolve => {
        call.signal?.addEventListener("abort", () => { aborted(); void execFinished.then(resolve); }, { once: true });
      });
      execSettled = true;
      return { code: 1, stdout: "", stderr: "cancelled" };
    },
  });
  let response: Promise<Response> | undefined;
  try {
    response = fetch(`${f.base}/project/preview/1`);
    await started;
    let closeSettled = false;
    const closing = f.runtime.close().then(() => { closeSettled = true; });
    await abortSeen;
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    finishExec();
    await closing;
    expect(execSettled).toBe(true);
    const reply = await response;
    await reply.arrayBuffer();
    expect(streams.paths).toEqual([]);
    await expect(readFile(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.reference)).toBeTruthy();
    const metricDir = join(f.dir, ".decupa", "metrics");
    const files = await readdir(metricDir);
    const journal = (await Promise.all(files.map(file => readFile(join(metricDir, file), "utf8")))).join("\n");
    expect(journal).toContain('"kind":"operation-finished"');
    expect(journal).toContain('"operation":"preview-playback"');
  } finally {
    finishExec();
    if (response) await response.then(reply => reply.arrayBuffer()).catch(() => undefined);
    await f.close();
  }
});

it("falls back to the reference after a failed conversion and retries for a new revision", async () => {
  streams.paths.length = 0;
  let conversions = 0;
  const f = await fixture({
    async run() {
      conversions += 1;
      return { code: 1, stdout: "", stderr: "encode failed" };
    },
  });
  try {
    const first = await fetch(`${f.base}/project/preview/1`);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.text()).toBe("preview streamed");
    const second = await fetch(`${f.base}/project/preview/1`);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("preview streamed");
    expect(conversions).toBe(1);
    expect(streams.paths).toEqual([f.reference, f.reference]);

    const journalDir = join(f.dir, ".decupa", "metrics");
    const files = await readdir(journalDir);
    const journal = (await Promise.all(files.map(file => readFile(join(journalDir, file), "utf8")))).join("\n");
    expect(journal).toContain('"outcome":"error"');
    expect(journal).toContain('"kind":"operation-finished"');
    expect(journal).toContain("previous-conversion-error");

    const revisionTwo = join(f.dir, "rev-2", "reference.mp4");
    await mkdir(join(f.dir, "rev-2"), { recursive: true });
    await copyFile(f.reference, revisionTwo);
    const artifactSha = await hashFile(revisionTwo);
    await saveProject(f.dir, 1, current => ({
      ...current,
      revision: 2,
      assembly: { ...current.assembly, revision: 2 },
      previewRevision: 2,
      previewArtifact: {
        revision: 2, relativePath: "rev-2/reference.mp4", sha256: artifactSha,
        assemblySha256: createHash("sha256").update(JSON.stringify({ ...current.assembly, revision: 2 })).digest("hex"),
      },
    }));
    const nextRevision = await fetch(`${f.base}/project/preview/2`);
    expect(nextRevision.status).toBe(200);
    expect(await nextRevision.text()).toBe("preview streamed");
    expect(conversions).toBe(2);
    expect(streams.paths).toEqual([f.reference, f.reference, revisionTwo]);
  } finally {
    await f.close();
  }
});

it("does not memoize cancellation as a conversion failure", async () => {
  streams.paths.length = 0;
  let conversions = 0;
  let interrupted!: () => void;
  const aborted = new Promise<void>(resolve => { interrupted = resolve; });
  const f = await fixture({
    async run(call) {
      conversions += 1;
      const output = call.args.at(-1)!;
      if (conversions === 1) {
        await writeFile(output, "partial mp4");
        return new Promise(resolve => {
          call.signal?.addEventListener("abort", () => {
            interrupted();
            resolve({ code: 1, stdout: "", stderr: "cancelled" });
          }, { once: true });
        });
      }
      await copyFile(f.reference, output);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  try {
    const controller = new AbortController();
    const canceledRequest = fetch(`${f.base}/project/preview/1`, { signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(conversions).toBe(1));
    controller.abort();
    await aborted;
    await canceledRequest;
    const metricDir = join(f.dir, ".decupa", "metrics");
    await vi.waitFor(async () => {
      const files = await readdir(metricDir);
      const journal = (await Promise.all(files.map(file => readFile(join(metricDir, file), "utf8")))).join("\n");
      expect(journal).toContain('"kind":"operation-finished"');
    });

    const retry = await fetch(`${f.base}/project/preview/1`);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("preview streamed");
    expect(conversions).toBe(2);
    expect(streams.paths).toHaveLength(1);
    expect(streams.paths[0]).toMatch(/rev-1\/playback-v1-[a-f0-9]{64}\.mp4$/);
    expect((await readdir(join(f.dir, "rev-1"))).some(name => name.endsWith(".tmp.mp4"))).toBe(false);
  } finally {
    await f.close();
  }
});
