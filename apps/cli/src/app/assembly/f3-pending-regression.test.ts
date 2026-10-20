import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createResidentSpeechClient } from "@decupa/transcript";
import { fixtureAssembly } from "./fixture.ts";
import { blankProject, createAssemblyRuntime, publishCorrection } from "./routes.ts";
import { createProject, loadProject } from "./store.ts";
import { runPreparation } from "./preparation.ts";
import type { Source } from "./types.ts";

vi.mock("./analysis.ts", () => ({
  analyzeSource: async (source: Source) => ({
    sourceId: source.id, key: `analysis-${source.id}`,
    speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 1, text: "fala inicial" }],
    visual: [], status: "ready", words: [], wordsStatus: "missing",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }),
}));
vi.mock("./media.ts", () => ({
  ensurePlayback: async (source: Source) => ({ videoPath: source.path }),
  verifySourceIdentity: async () => undefined,
}));
vi.mock("./waveform.ts", () => ({
  buildPeaks: async () => undefined, peaksPath: () => "/tmp/f3-pending-peaks.json",
}));
vi.mock("./render.ts", () => ({ renderAssembly: async () => "/tmp/f3-pending-render.mp4" }));
vi.mock("@decupa/media", async (importOriginal) => ({
  ...await importOriginal<typeof import("@decupa/media")>(),
  hashFile: async () => "c".repeat(64),
  extractAudio: async () => undefined,
  readPcm: async () => { throw new Error("sem refino acústico neste teste"); },
}));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "decupa-f3-pending-"));
  const project = blankProject("f3-pending");
  project.input = { kind: "brief", text: "montar a fala", targetSeconds: 0 };
  project.assembly.sources = [{ ...fixtureAssembly().sources[0]!, hasVideo: false, size: 1, mtimeMs: 1 }];
  project.corrections = [{ id: "c1", sourceId: "a", start: 0, end: 1, text: "fala inicial", status: "pending", words: [] }];
  await createProject(dir, project);
});
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

const exec = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
const request = { mode: "prepare" as const, request: "preparar", modelOptIn: true, visualOptIn: false };
const control = () => ({ signal: new AbortController().signal, isCurrent: () => true });
const proposal = JSON.stringify({
  scenes: [{ id: "s1", objective: "abertura", rationale: "fala", speechIds: ["a:u001"], support: [], gaps: [] }],
  changedSceneIds: ["s1"],
});
const settle = () => publishCorrection(dir, 0, "c1", { words: [
  { text: "fala", start: 0.1, end: 0.4, confidence: 0.9 },
  { text: "inicial", start: 0.5, end: 0.9, confidence: 0.9 },
] });

it("R2: assentamento em background e retomada gastam no máximo uma proposta textual", async () => {
  vi.useFakeTimers();
  let textual = 0;
  const deps = { exec, proposeSend: async () => {
    textual += 1;
    // Reprodução R2: na base defeituosa a correção assenta durante a chamada paga.
    if (textual === 1) await settle();
    return proposal;
  } };
  let finished = false;
  const run = runPreparation(dir, 0, request, deps, control()).then((project) => {
    finished = true;
    return project;
  });
  await vi.waitFor(async () => {
    expect((await loadProject(dir)).preparation?.stage).toBe("proposal");
  });
  for (let elapsed = 0; elapsed <= 31_000 && !finished; elapsed += 250) {
    await vi.advanceTimersByTimeAsync(250);
    await loadProject(dir); // Deixa a recarga real em disco avançar junto do relógio falso.
  }
  await vi.waitFor(() => { expect(finished).toBe(true); });
  const first = await run;
  vi.useRealTimers();
  // Com a barreira, o worker pode assentar após a interrupção sem edição humana.
  await settle();
  const second = await runPreparation(dir, first.revision, request, deps, control());
  expect(second.preparation?.status).toBe("ready");
  expect(textual).toBe(1);
  expect(first.preparation?.status).toBe("interrupted");
  expect(first.preparation?.error).toMatch(/correção em alinhamento.*retome em instantes/);
  expect(first.preparation?.error).not.toContain("edição preservada");
});

it("close do cliente residente mantém pending e o próximo GET relança o alinhamento", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const client = createResidentSpeechClient({ spawn: () => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: { write: () => { entered(); return true; }, end: () => undefined },
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
    });
    return child as ChildProcess;
  } });
  const runtime = createAssemblyRuntime(dir, { exec, port: () => 0, speech: {
    worker: client.transcribe,
  } });
  const server = createServer((req, res) => { void runtime.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("porta não disponível");
  const url = `http://127.0.0.1:${address.port}/project`;
  try {
    await fetch(url);
    await started;
    await client.close();
    // Um runtime novo simula a reabertura com worker saudável. GET inicia o retry.
    await runtime.close();
    const worker = vi.fn(async () => ({ language: "pt", words: [
      { text: "fala", startMs: 100, endMs: 400, confidence: 0.9, sentenceIndex: 0 },
      { text: "inicial", startMs: 500, endMs: 900, confidence: 0.9, sentenceIndex: 0 },
    ], unaligned: [] }));
    const reopened = createAssemblyRuntime(dir, { exec, port: () => 0, speech: { worker } });
    server.removeAllListeners("request");
    server.on("request", (req, res) => { void reopened.handle(req, res); });
    await vi.waitFor(async () => {
      await fetch(url);
      expect((await loadProject(dir)).corrections[0]?.status).toBe("aligned");
    }, { timeout: 2000, interval: 20 });
    expect(worker).toHaveBeenCalledTimes(1);
    await reopened.close();
  } finally {
    await client.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each(["exit", "spawn", "error", "watchdog"])("falha %s do worker publica error e permite preparar sem aguardar assentamento", async (failure) => {
  const client = createResidentSpeechClient({ watchdogMs: 10, spawn: () => {
    if (failure === "spawn") throw new Error("uv ausente");
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: { write: () => {
        if (failure === "exit") queueMicrotask(() => child.emit("exit", 1, null));
        if (failure === "error") queueMicrotask(() => child.emit("error", new Error("uv ausente")));
        return true;
      }, end: () => undefined },
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
    });
    return child as ChildProcess;
  } });
  const runtime = createAssemblyRuntime(dir, { exec, port: () => 0, speech: { worker: client.transcribe } });
  const server = createServer((req, res) => { void runtime.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("porta não disponível");
  const url = `http://127.0.0.1:${address.port}/project`;
  try {
    await fetch(url);
    await vi.waitFor(async () => {
      expect((await loadProject(dir)).corrections[0]?.status).toBe("error");
    }, { timeout: 1000, interval: 20 });
    let calls = 0;
    const done = await runPreparation(dir, 0, request, { exec, proposeSend: async () => {
      calls += 1;
      return proposal;
    } }, control());
    expect(done.preparation?.status).toBe("ready");
    expect(done.corrections[0]?.status).toBe("error");
    expect(calls).toBe(1);
  } finally {
    await client.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
