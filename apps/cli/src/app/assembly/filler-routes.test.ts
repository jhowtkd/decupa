import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { createAssemblyRuntime, type AssemblyDeps } from "./routes.ts";
import { createProject, loadProject, saveProject } from "./store.ts";
import { fillerProject, fillerPcmExec } from "./filler-test-helper.ts";
import { readAssemblyFillerNotes } from "./filler-observe.ts";
import { fillerReport } from "./fillers.ts";

async function route(runtime: ReturnType<typeof createAssemblyRuntime>, dir: string, path: string, body?: unknown) {
  const req = { method: body === undefined ? "GET" : "POST", url: path, headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  let status = 0, payload = "";
  const res = { writeHead(code: number) { status = code; }, end(value?: unknown) { if (typeof value === "string") payload = value; } };
  await runtime.handleAssembly(req as unknown as IncomingMessage, res as unknown as ServerResponse, dir);
  return { status, body: JSON.parse(payload) };
}

async function seed(deps: Partial<AssemblyDeps> = {}, text = "é") {
  const dir = await mkdtemp(join(tmpdir(), "fillers-routes-")), p = fillerProject(text);
  p.scenes.push({ ...p.scenes[0]!, id: "s2", takes: [{ ...p.scenes[0]!.takes[0]!, id: "t2" }] });
  await createProject(dir, p);
  return { dir, p, runtime: createAssemblyRuntime(dir, { exec: fillerPcmExec(), port: () => 0, ...deps }) };
}

it("snapshot mantém ocorrência; corte/restauração em lote fazem uma revisão e undo recompõe exceções", async () => {
  const { dir, p, runtime } = await seed();
  const initial = await route(runtime, dir, "/project");
  expect(initial.body.fillerReport.groups[0].items).toHaveLength(2);
  const targets = fillerReport(p).occurrences.map(({ candidateId, sceneId, takeId }) => ({ candidateId, sceneId, takeId }));
  const cut = await route(runtime, dir, "/project/fillers-cut", { baseRevision: 1, targets });
  expect(cut.status).toBe(200); expect(cut.body.project.revision).toBe(2);
  expect(cut.body.fillerReport.totals.cut).toBe(2);
  expect(cut.body.project.assembly.revision).toBe(2);
  const stale = await route(runtime, dir, "/project/fillers-restore", { baseRevision: 1, targets });
  expect(stale.status).toBe(409);
  const restored = await route(runtime, dir, "/project/fillers-restore", { baseRevision: 2, targets });
  expect(restored.status).toBe(200); expect(restored.body.project.revision).toBe(3);
  expect(restored.body.project.scenes.every((s: { takes: { removed: unknown[] }[] }) => !s.takes[0]!.removed.length)).toBe(true);
  expect(restored.body.project.fillerExceptions).toEqual([{ wordId: "w2", text: "é" }]);
  const undo = await route(runtime, dir, "/project/undo", { baseRevision: 3, revision: 2 });
  expect(undo.status).toBe(200); expect(undo.body.project.fillerExceptions).toEqual([]);
  expect(undo.body.project.scenes[0].takes[0].fillers.cuts).toHaveLength(1);
  const redo = await route(runtime, dir, "/project/fillers-restore", { baseRevision: 4, targets });
  expect(redo.status).toBe(200); expect(redo.body.project.fillerExceptions).toEqual([{ wordId: "w2", text: "é" }]);
});

it("recusa identidade sem take/cena e revisão que muda enquanto ffmpeg calcula snaps", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const exec = fillerPcmExec();
  const { dir, p, runtime } = await seed({ exec: { run: async call => { started(); await gate; return exec.run(call); } } });
  const target = fillerReport(p).occurrences[0]!;
  expect((await route(runtime, dir, "/project/fillers-cut", { baseRevision: 1, targets: [{ candidateId: target.candidateId }] })).status).toBe(400);
  const pending = route(runtime, dir, "/project/fillers-cut", { baseRevision: 1, targets: [target] });
  await entered;
  await saveProject(dir, 1, current => ({ ...current, revision: 2, assembly: { ...current.assembly, revision: 2 } }));
  release(); expect((await pending).status).toBe(409);
  expect((await loadProject(dir)).scenes.every(s => !s.takes[0]!.removed.length)).toBe(true);
});

it("correção na mesma revisão invalida snap dentro do escritor síncrono", async () => {
  let dirForExec = "";
  const exec = fillerPcmExec();
  const { dir, p, runtime } = await seed({ exec: { run: async call => {
    await saveProject(dirForExec, 1, current => ({ ...current, corrections: [{ id: "c", sourceId: "a", start: 0.6, end: 0.8, status: "aligned", text: "tá", words: [{ ...current.analyses[0]!.words[1]!, text: "tá" }] }] }));
    return exec.run(call);
  } } });
  dirForExec = dir;
  const response = await route(runtime, dir, "/project/fillers-cut", { baseRevision: 1, targets: [fillerReport(p).occurrences[0]!] });
  expect(response.status).toBe(200); expect(response.body.project.revision).toBe(1);
  expect(response.body.project.scenes[0].takes[0].removed).toEqual([]);
  expect(response.body.fillerReport.groups[0].items[0]).toMatchObject({ state: "abstain", reason: "palavras mudaram; reabra os cacoetes" });
  expect((await route(runtime, dir, "/project")).body.fillerReport.groups[0].items[0].state).toBe("signal");
});


it("aceitar proposta e template aplicam hesitação antes da compilação/revisão final", async () => {
  for (const path of ["/project/apply", "/project/template-accept"]) {
    const { dir, p, runtime } = await seed({}, "hã");
    const proposal = { id: "proposal", baseRevision: 1, scenes: p.scenes, changedSceneIds: ["s1", "s2"], explanation: "tema" };
    if (path.endsWith("template-accept")) await writeFile(join(dir, "template-proposal.json"), JSON.stringify(proposal));
    else await saveProject(dir, 1, current => ({ ...current, proposal }));
    const response = await route(runtime, dir, path, { baseRevision: 1, proposalId: "proposal" });
    expect(response.status).toBe(200); expect(response.body.project.revision).toBe(2); expect(response.body.project.assembly.revision).toBe(2);
    expect(response.body.project.scenes.every((s: { takes: { fillers: { cuts: { origin: string }[] } }[] }) => s.takes[0]!.fillers.cuts[0]!.origin === "auto")).toBe(true);
    expect(response.body.fillerReport.totals.cut).toBe(2);
  }
});


it("GET do projeto montado dispara Jev dedicado e o poll publica nota sem nova revisão", async () => {
  const decide = vi.fn(async (req: { model?: string; questions: Record<string, unknown> }) => ({ model: req.model!,
    answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul" as const, noul: 0.82 }])) }));
  const { dir, runtime } = await seed({ decision: { mode: "observe", model: "fake-model" }, fillerObserveClient: { decide } });
  expect(decide).not.toHaveBeenCalled();
  expect((await route(runtime, dir, "/project")).status).toBe(200);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]?.score).toBe(0.82));
  const poll = await route(runtime, dir, "/project");
  expect(poll.body.project.revision).toBe(1);
  expect(poll.body.fillerReport.occurrences.every((o: { note?: { score: number } }) => o.note?.score === 0.82)).toBe(true);
  expect(decide).toHaveBeenCalledTimes(1);
});

it("ajuste parcial planeja e aplica automático só nas cenas de changedSceneIds", async () => {
  let calls = 0;
  const { dir, p, runtime } = await seed({ exec: fillerPcmExec(() => calls++) }, "hã");
  const proposal = { id: "partial", baseRevision: 1, scenes: [{ ...p.scenes[0]!, objective: "novo" }, { id: "s2" }], changedSceneIds: ["s1"], explanation: "ajuste parcial" };
  await saveProject(dir, 1, current => ({ ...current, proposal: proposal as typeof current.proposal }));
  const response = await route(runtime, dir, "/project/apply", { baseRevision: 1, proposalId: "partial" });
  expect(response.status).toBe(200); expect(response.body.project.revision).toBe(2);
  expect(response.body.project.scenes[0].takes[0].fillers.cuts).toHaveLength(1);
  expect(response.body.project.scenes[1]).toEqual(p.scenes[1]);
  expect(calls).toBe(1);
});

it("Cortar depois de Restaurar remove a exceção e aplica o mesmo alvo", async () => {
  const { dir, p, runtime } = await seed();
  const targets = [fillerReport(p).occurrences[0]!];
  await route(runtime, dir, "/project/fillers-cut", { baseRevision: 1, targets });
  await route(runtime, dir, "/project/fillers-restore", { baseRevision: 2, targets });
  const cut = await route(runtime, dir, "/project/fillers-cut", { baseRevision: 3, targets });
  expect(cut.status).toBe(200); expect(cut.body.project.revision).toBe(4);
  expect(cut.body.project.fillerExceptions).toEqual([]);
  expect(cut.body.fillerReport.occurrences[0].state).toBe("cut");
});


it("desconexão da resposta cancela PCM e não grava uma edição", async () => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const { dir, p, runtime } = await seed({ exec: { run: call => new Promise((_, reject) => {
    expect(call.signal).toBeDefined();
    call.signal!.addEventListener("abort", () => reject(call.signal!.reason), { once: true });
    started();
  }) } });
  const body = { baseRevision: 1, targets: [fillerReport(p).occurrences[0]!] };
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/project/fillers-cut", headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, writeHead() {}, end() {} });
  const pending = runtime.handleAssembly(req as unknown as IncomingMessage, res as unknown as ServerResponse, dir);
  const rejected = expect(pending).rejects.toThrow(/aborted/i);
  await entered; res.emit("close"); await rejected;
  expect((await loadProject(dir)).revision).toBe(1);
  expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("close")).toBe(0);
});
