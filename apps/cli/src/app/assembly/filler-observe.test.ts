import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { FillerObserveClient } from "@decupa/triage";
import { assemblyFillerReport, observeAssemblyFillers, readAssemblyFillerNotes } from "./filler-observe.ts";
import { fillerProject } from "./filler-test-helper.ts";

const decision = { mode: "observe" as const, model: "decision-test" };

it("falha fica registrada, sem retry por poll ou reinício da geração", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fillers-observe-")), p = fillerProject("é");
  const decide = vi.fn(async () => { throw Error("indisponível"); });
  const deps = { decision, fillerObserveClient: { decide } };
  await observeAssemblyFillers(dir, p, deps);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]).toMatchObject({ score: null, decisionFailure: "falha na decisão Jev", model: "decision-test" }));
  for (let i = 0; i < 3; i++) expect((await assemblyFillerReport(dir, p, deps)).occurrences[0]!.note?.score).toBeNull();
  expect(decide).toHaveBeenCalledTimes(1);
  expect(p.revision).toBe(1);
  expect(p.scenes[0]!.takes[0]!.removed).toEqual([]);
});

it("configurar a chave depois ativa notas; trocar chave ruim permite nova tentativa", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observe-keys-")), p = fillerProject("é");
  let apiKey: string | undefined; const keys: string[] = [];
  const fetchImpl = (async (_url, init) => {
    keys.push(new Headers(init?.headers).get("authorization")!);
    if (apiKey === "bad") return new Response("{}", { status: 401 });
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.8 }])) }));
  }) as typeof fetch;
  const deps = { fillerFetchImpl: fetchImpl, resolveOperationDeps: async () => ({ decision,
    fillerEnv: apiKey ? { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: apiKey } : {}, fillerConfigKey: apiKey ?? "missing" }) };
  await assemblyFillerReport(dir, p, deps); expect(keys).toEqual([]);
  apiKey = "bad"; await assemblyFillerReport(dir, p, deps);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]?.score).toBeNull());
  apiKey = "good"; await assemblyFillerReport(dir, p, deps);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]?.score).toBe(0.8));
  expect(keys).toEqual(["Bearer bad", "Bearer good"]);
});

it("geração nova aborta e descarta resposta antiga que ignora cancelamento", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fillers-late-")), old = fillerProject("é"), next = fillerProject("tá");
  let release!: () => void, oldSignal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const decide: FillerObserveClient["decide"] = vi.fn<FillerObserveClient["decide"]>(async (req, signal) => {
    if (Object.keys(req.questions)[0] === "ambiguous:w2" && !oldSignal) { oldSignal = signal; await gate; }
    return { model: req.model!, answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul", noul: req.state && JSON.stringify(req.state).includes("tá") ? 0.8 : 0.1 }])) };
  });
  const deps = { decision, fillerObserveClient: { decide } };
  await observeAssemblyFillers(dir, old, deps);
  await vi.waitFor(() => expect(oldSignal).toBeDefined());
  await observeAssemblyFillers(dir, next, deps);
  expect(oldSignal!.aborted).toBe(true);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]?.score).toBe(0.8));
  release();
  await vi.waitFor(async () => expect((await assemblyFillerReport(dir, next, deps)).pending).toBe(false));
  expect((await assemblyFillerReport(dir, next, deps)).occurrences[0]!.note?.score).toBe(0.8);
  expect((await assemblyFillerReport(dir, old, { decision: { mode: "off", model: "decision-test" } })).occurrences[0]!.note).toBeUndefined();
});

it("capa em 100 perguntas/5 lotes, informa excedente e replica a nota nas duas cenas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fillers-cap-")), p = fillerProject("é");
  const pattern = p.analyses[0]!.words;
  p.assembly.sources[0]!.durationSeconds = 220;
  p.analyses[0]!.words = Array.from({ length: 105 }, (_, n) => pattern.map((w, i) => ({ ...w, id: `w${n}:${i}`, start: w.start + n * 2, end: w.end + n * 2 }))).flat();
  p.analyses[0]!.speech = Array.from({ length: 105 }, (_, n) => ({ id: `u${n}`, sourceId: "a", start: n * 2, end: n * 2 + 1.5, text: "eu é acho" }));
  p.scenes[0]!.takes[0]!.end = 210;
  p.scenes.push({ ...p.scenes[0]!, id: "s2", takes: [{ ...p.scenes[0]!.takes[0]!, id: "t2" }] });
  const decide = vi.fn<FillerObserveClient["decide"]>(async req => ({ model: req.model!, answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul", noul: 0.82 }])) }));
  const deps = { decision, fillerObserveClient: { decide } };
  await observeAssemblyFillers(dir, p, deps);
  await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes).toHaveLength(100));
  expect(decide).toHaveBeenCalledTimes(5);
  expect(decide.mock.calls.every(([req]) => Object.keys(req.questions).length === 20 && req.model === "decision-test")).toBe(true);
  const report = await assemblyFillerReport(dir, p, deps);
  expect(report.totals.excess).toBe(5);
  expect(report.occurrences.filter(o => o.note)).toHaveLength(200);
  await assemblyFillerReport(dir, p, deps);
  expect(decide).toHaveBeenCalledTimes(5);
});

it("preparação em andamento, modo off e falta de chave nunca chamam observe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fillers-gate-")), p = fillerProject("é");
  const decide = vi.fn<FillerObserveClient["decide"]>(async () => ({ model: "decision-test", answers: {} }));
  const off = { decision: { ...decision, mode: "off" as const }, fillerObserveClient: { decide } };
  await observeAssemblyFillers(dir, p, off);
  await observeAssemblyFillers(dir, p, { decision, fillerEnv: {} });
  p.preparation = { id: "prep", revision: 1, mode: "prepare", request: "", status: "running", stage: "preview", sources: {} };
  await observeAssemblyFillers(dir, p, { decision, fillerObserveClient: { decide } });
  expect(decide).not.toHaveBeenCalled();
});

it("cliente observe usa modelo da decisão e apenas um fetch 429/529, sem context.client", async () => {
  for (const status of [429, 529]) {
    const dir = await mkdtemp(join(tmpdir(), "fillers-one-fetch-")), p = fillerProject("é");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"error":"busy"}', { status }));
    const retryingClient = { decide: vi.fn(async () => { throw Error("não usar este cliente"); }) };
    const deps = { decision: { ...decision, client: retryingClient }, fillerEnv: { DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "fake-key" }, fillerFetchImpl: fetchImpl };
    await observeAssemblyFillers(dir, p, deps);
    await vi.waitFor(async () => expect((await readAssemblyFillerNotes(dir))?.notes[0]?.decisionFailure).toBe("Jev indisponível"));
    await assemblyFillerReport(dir, p, deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(retryingClient.decide).not.toHaveBeenCalled();
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).model).toBe("decision-test");
  }
});
