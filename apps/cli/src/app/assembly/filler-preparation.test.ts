import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fillerProject, fillerPcmExec } from "./filler-test-helper.ts";
import { compileScenes } from "./scenes.ts";
import { runPreparation } from "./preparation.ts";
import { createProject, loadProject, readHistorySnapshot, saveProject } from "./store.ts";
import { readAssemblyFillerNotes } from "./filler-observe.ts";
import { readAnalysisCredentials, writeCredentials, type FillerObserveClient } from "@decupa/triage";
import { operationResolver } from "../analysis-operation.ts";

const rendering = vi.hoisted(() => ({ fail: false }));

vi.mock("./media.ts", async importOriginal => ({ ...await importOriginal<object>(),
  verifySourceIdentity: async () => undefined, ensurePlayback: async () => ({ videoPath: "/fake/proxy.mp4" }),
}));
vi.mock("./waveform.ts", async importOriginal => ({ ...await importOriginal<object>(), buildPeaks: async () => null }));
vi.mock("./analysis.ts", async importOriginal => ({ ...await importOriginal<object>(), analyzeSource: async (_source: unknown, dir: string) => (await loadProject(dir)).analyses[0] }));
vi.mock("./render.ts", async importOriginal => ({ ...await importOriginal<object>(), renderAssembly: async (_assembly: unknown, dir: string) => {
  if (rendering.fail) throw Error("prévia indisponível");
  const path = join(dir, "reference.mp4"); await writeFile(path, "fake-preview"); return path;
} }));

const proposal = JSON.stringify({ scenes: [{ id: "s1", objective: "tema", selections: [{ takeId: "t1" }] }], changedSceneIds: ["s1"], gaps: [] });

async function seed(text = "hã") {
  const dir = await mkdtemp(join(tmpdir(), "filler-prep-")), p = fillerProject(text);
  p.assembly.sources[0]!.hasVideo = false;
  p.assembly = compileScenes(p, p.scenes);
  await createProject(dir, p);
  return { dir, p };
}

it("preparação aplica automático com callback síncrono, uma revisão e preparedRevision", async () => {
  const { dir, p } = await seed(); let pcmCalls = 0;
  const done = await runPreparation(dir, p.revision, { mode: "prepare", request: "tema", modelOptIn: true, visualOptIn: false },
    { exec: fillerPcmExec(() => pcmCalls++), proposeSend: async () => proposal }, { signal: new AbortController().signal, isCurrent: () => true });
  expect(done.preparation?.status).toBe("ready");
  expect(done.revision).toBe(2); expect(done.preparedRevision).toBe(2); expect(done.assembly.revision).toBe(2);
  expect(done.scenes[0]!.takes[0]!.fillers!.cuts[0]!.origin).toBe("auto"); expect(pcmCalls).toBe(1);
  expect((await readHistorySnapshot(dir, 1)).scenes[0]!.takes[0]!.removed).toEqual([]);
});

it("desligar durante uma preparação impede as notas que ela ainda não despachou", async () => {
  const { dir, p } = await seed("é"), user = await mkdtemp(join(tmpdir(), "prep-keys-"));
  await writeCredentials(user, { preset: "zai", apiKey: "text", typesafeApiKey: "old-jev", typesafe: true });
  const calls: string[] = [];
  const fetchImpl = (async (_url, init) => {
    calls.push(new Headers(init?.headers).get("authorization")!);
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.8 }])) }));
  }) as typeof fetch;
  const resolveOperationDeps = operationResolver({ dir, loadStored: () => readAnalysisCredentials(dir, user), env: {}, fetchImpl, enableVisual: false });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const run = runPreparation(dir, p.revision, { mode: "prepare", request: "tema", modelOptIn: true, visualOptIn: false },
    { exec: fillerPcmExec(), fillerFetchImpl: fetchImpl, resolveOperationDeps, proposeSend: async () => { entered(); await gate; return proposal; } },
    { signal: new AbortController().signal, isCurrent: () => true });
  await started; await writeCredentials(user, { preset: "zai", apiKey: "text", typesafe: false }); release();
  expect((await run).preparation?.status).toBe("ready");
  expect(await readAssemblyFillerNotes(dir)).toBeNull();
  expect(calls).toEqual([]);
  expect((await resolveOperationDeps()).decision.client).toBeUndefined();
});

it("preparação obsoleta depois do PCM não aplica proposta nem cacoete", async () => {
  const { dir, p } = await seed(); let current = true;
  const fake = fillerPcmExec();
  const done = await runPreparation(dir, 1, { mode: "prepare", request: "tema", modelOptIn: true, visualOptIn: false },
    { exec: { run: async call => { const result = await fake.run(call); current = false; return result; } }, proposeSend: async () => proposal },
    { signal: new AbortController().signal, isCurrent: () => current });
  expect(done.revision).toBe(p.revision); expect(done.scenes[0]!.takes[0]!.removed).toEqual([]);
});

it("nota do Jev roda apenas após estado terminal salvo e não muda revisão", async () => {
  for (const status of ["ready", "attention"]) {
  rendering.fail = status === "attention";
  const { dir, p } = await seed("é");
  const decide = vi.fn<FillerObserveClient["decide"]>(async req => {
    expect((await loadProject(dir)).preparation?.status).toBe(status);
    return { model: req.model!, answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul", noul: 0.82 }])) };
  });
  const done = await runPreparation(dir, 1, { mode: "prepare", request: "tema", modelOptIn: true, visualOptIn: false },
    { exec: fillerPcmExec(), proposeSend: async () => { expect(decide).not.toHaveBeenCalled(); return proposal; },
      decision: { mode: "observe", model: "fake-decision" }, fillerObserveClient: { decide } },
    { signal: new AbortController().signal, isCurrent: () => true });
  expect(done.revision).toBe(p.revision + 1);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]?.score).toBe(0.82));
  expect(decide).toHaveBeenCalledTimes(1); expect((await loadProject(dir)).revision).toBe(done.revision);
  expect(done.scenes[0]!.takes[0]!.removed).toEqual([]);
  }
  rendering.fail = false;
});


it("Ajuste com IA preserva cacoetes fora do escopo; Preparar completo cobre todas as cenas", async () => {
  for (const mode of ["adjust", "prepare"] as const) {
    const { dir, p } = await seed();
    p.scenes.push({ ...p.scenes[0]!, id: "s2", takes: [{ ...p.scenes[0]!.takes[0]!, id: "t2" }] });
    await saveProject(dir, 1, () => p);
    let calls = 0;
    const partial = JSON.stringify({ scenes: [{ id: "s1", objective: "novo", selections: [{ takeId: "t1" }] }, { id: "s2" }], changedSceneIds: ["s1"], gaps: [] });
    const done = await runPreparation(dir, 1, { mode, request: "tema", modelOptIn: true, visualOptIn: false },
      { exec: fillerPcmExec(() => calls++), proposeSend: async () => partial }, { signal: new AbortController().signal, isCurrent: () => true });
    expect(done.preparation?.status).toBe("ready"); expect(done.revision).toBe(2);
    expect(done.scenes[0]!.takes[0]!.fillers!.cuts).toHaveLength(1);
    if (mode === "adjust") { expect(done.scenes[1]).toEqual(p.scenes[1]); expect(calls).toBe(1); }
    else { expect(done.scenes[1]!.takes[0]!.fillers!.cuts).toHaveLength(1); expect(calls).toBe(2); }
  }
});
