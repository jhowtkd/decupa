import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hashFile } from "@decupa/media";
import { summarizeReuseJournals } from "@decupa/bench";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { createAssemblyRuntime } from "./routes.ts";
import { loadProject } from "./store.ts";
import { runPreparation } from "./preparation.ts";

vi.mock("./render.ts", () => ({ renderAssembly: async (
  _assembly: unknown, dir: string, _exec: unknown, opts?: { onStarted?: () => void },
) => {
  opts?.onStarted?.();
  const folder = join(dir, "preview-cache");
  await mkdir(folder, { recursive: true });
  const out = join(folder, "test.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), out);
  return out;
} }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function serve(runtime: ReturnType<typeof createAssemblyRuntime>): Promise<string> {
  const server = createServer((req, res) => { void runtime.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await runtime.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  return `http://127.0.0.1:${address.port}`;
}

async function journalText(dir: string): Promise<string> {
  const metricsDir = join(dir, ".decupa", "metrics");
  return (await Promise.all((await readdir(metricsDir)).map(file => readFile(join(metricsDir, file), "utf8")))).join("\n");
}

const exec: Executor = { async run(call) {
  const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd;
  if (work && call.args.includes("index")) {
    await mkdir(join(work, "out"), { recursive: true });
    await writeFile(join(work, "out", "speech_index.json"), JSON.stringify({ units: [{
      id: "u001", index: 1, start: 0, end: 1, duration: 1, text: "private transcript",
      has_terminal_punct: true, is_question: false, word_count: 2, cps: 1, lead_gap: 0,
      disfluency: { hard: [], soft: [], stutter: [] },
    }] }));
  }
  const output = call.args.at(-1) ?? "";
  if (output.endsWith(".tmp.mp4")) await copyFile(join(FIXTURES, "clip.mp4"), output);
  if (output.endsWith(".tmp.jpg")) await writeFile(output, "thumbnail");
  if (output.includes("%03d")) {
    const seconds = Number(call.args[call.args.indexOf("-t") + 1]);
    for (let index = 0; index < Math.ceil(seconds); index++) await writeFile(output.replace("%03d", String(index).padStart(3, "0")), "frame");
  }
  return { code: 0, stdout: "", stderr: "" };
} };

it("records automatic ASR builds before preparation hits in two projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-automatic-asr-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const media = join(root, "private-file.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const sha = await hashFile(media);
  let workerCalls = 0;
  const speech = { worker: async () => {
    workerCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { language: "pt", words: [{ text: "private transcript", startMs: 0, endMs: 800, confidence: 1, sentenceIndex: 0 }], unaligned: [] };
  }, extract: async () => {}, detectSilence: async () => [] };
  for (const name of ["first", "second"]) {
    const dir = join(root, name);
    const runtime = createAssemblyRuntime(dir, { exec, speech, port: () => 0,
      media: { getMedia: async () => ({ id: sha, path: media, nome: "private source name", tamanho: (await stat(media)).size, duracao: 3, criadoEm: 1 }) },
    });
    await runtime.ensureProject();
    const base = await serve(runtime);
    const response = await fetch(`${base}/project/media`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 0, mediaId: sha }),
    });
    expect(response.status).toBe(202);
    await response.json();
    await vi.waitFor(async () => { expect((await loadProject(dir)).analyses[0]?.status).toBe("ready"); expect(runtime.snapshot().operation?.stage).toBe("ready"); }, { timeout: 10_000 });
    const project = await loadProject(dir);
    const result = await runPreparation(dir, project.revision, {
      mode: "prepare", request: "private request", modelOptIn: true, visualOptIn: false,
    }, { exec, speech, proposeSend: async () => JSON.stringify({ scenes: [{ id: "scene", objective: "opening", selections: [{ speechId: project.analyses[0]!.speech[0]!.id }] }], changedSceneIds: ["scene"], gaps: [] }) },
    { signal: new AbortController().signal, isCurrent: () => true });
    expect(result.preparation?.status, result.preparation?.error).toBe("ready");
    const journals = await journalText(dir);
    for (const privateValue of [root, "private source name", "private transcript", "private request"]) expect(journals).not.toContain(privateValue);
  }
  expect(workerCalls).toBe(2);
  const summary = await summarizeReuseJournals(root);
  expect(summary.byStage.analysis).toMatchObject({ redundantBuilds: 1, opportunitiesWithoutBuild: 0 });
  expect(summary.byStage.analysis.estimatedSavingsMs).toBeGreaterThan(0);
  expect(summary.groups.find(group => group.stage === "analysis")).toMatchObject({ projects: 2, builds: 2, hits: 2 });
});

it("journals role-triggered ASR, explicit visual analysis and playback without private data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reuse-explicit-routes-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const media = join(dir, "private-file.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const runtime = createAssemblyRuntime(dir, { exec, port: () => 0, allowPaidVisual: true,
    speech: { worker: async () => ({ language: "pt", words: [{ text: "private transcript", startMs: 0, endMs: 800, confidence: 1, sentenceIndex: 0 }], unaligned: [] }), extract: async () => {}, detectSilence: async () => [] },
    describeClient: { model: "test", providerKey: "https://private.example/?secret=token", send: async () => JSON.stringify({ spans: [{ id: "v", start: 0, end: 3, text: "private visual response", confidence: "observed", tags: [] }] }) },
  });
  let project = await runtime.ensureProject([media]);
  const source = project.assembly.sources[0]!;
  const base = await serve(runtime);
  for (const role of ["speech", "both"]) {
    const response = await fetch(`${base}/project/source-role`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: project.revision, sourceIds: [source.id], role }) });
    expect(response.status).toBe(200);
    await response.json();
    project = await loadProject(dir);
  }
  const analysis = await fetch(`${base}/project/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceIds: [source.id], visual: true }) });
  expect(analysis.status).toBe(200);
  await analysis.json();
  for (let index = 0; index < 2; index++) {
    const playback = await fetch(`${base}/project/media/${source.id}?view=playback`);
    expect(playback.status).toBe(200);
    expect((await playback.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }
  await vi.waitFor(async () => { expect((await journalText(dir)).match(/"kind":"operation-finished"/g)).toHaveLength(4); }, { timeout: 10_000 });
  const journal = await journalText(dir);
  const caches = journal.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.kind === "cache").map(row => row.data);
  expect(caches.filter(row => row.stage === "analysis").map(row => row.outcome)).toEqual(expect.arrayContaining(["built", "hit-or-shared"]));
  expect(caches).toContainEqual(expect.objectContaining({ stage: "visual", outcome: "built", configKey: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  expect(caches.filter(row => row.stage === "proxy").map(row => row.outcome)).toEqual(expect.arrayContaining(["built", "hit"]));
  for (const privateValue of [dir, "private transcript", "private visual response", "private.example", "secret=token", "Você recebe frames"]) expect(journal).not.toContain(privateValue);
});

it("journals analysis required by a template proposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reuse-template-proposal-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const media = join(dir, "private-file.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  let speechId = "";
  const runtime = createAssemblyRuntime(dir, { exec, port: () => 0, templatesRoot: join(dir, "templates"), allowPaidVisual: true, allowPaidModel: true,
    speech: { worker: async () => ({ language: "pt", words: [{ text: "private transcript", startMs: 0, endMs: 800, confidence: 1, sentenceIndex: 0 }], unaligned: [] }), extract: async () => {}, detectSilence: async () => [] },
    describeClient: { model: "test", providerKey: "private-provider", send: async () => JSON.stringify({ spans: [{ id: "v", start: 0, end: 3, text: "private visual response", confidence: "observed", tags: [] }] }) },
    proposeSend: async () => JSON.stringify({ scenes: [{ id: "scene", objective: "opening", selections: [{ speechId }] }], changedSceneIds: ["scene"], gaps: [] }),
  });
  const project = await runtime.ensureProject([media]);
  speechId = `${project.assembly.sources[0]!.id}:u001`;
  const base = await serve(runtime);
  const response = await fetch(`${base}/project/template-proposal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: project.revision, templateId: null, request: "private request" }) });
  expect(response.status).toBe(200);
  await response.json();
  await vi.waitFor(async () => { expect(await journalText(dir)).toContain('"kind":"operation-finished"'); }, { timeout: 10_000 });
  const journal = await journalText(dir);
  const caches = journal.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.kind === "cache").map(row => row.data);
  for (const stage of ["analysis", "visual"]) expect(caches).toContainEqual(expect.objectContaining({ stage, outcome: "built", configKey: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  for (const privateValue of [dir, "private transcript", "private visual response", "private request", "private-provider"]) expect(journal).not.toContain(privateValue);
});
