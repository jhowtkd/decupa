import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fillerNoteKey, FILLER_JEV_QUESTION_VERSION, type FillerNote, type FillerObserveItem, type FillerObserveClient } from "@decupa/triage";
import { cleanupFillerNotes } from "./filler-notes.ts";
const items = (n: number, prefix = "a"): FillerObserveItem[] => Array.from({ length: n }, (_, i) => ({ candidate: {
  id: `${prefix}${i}`, category: "ambiguous", token: "é", wordIds: [`w${i}`], start: i, end: i + 0.1, rule: "r", verdict: "signal",
}, unitText: `${prefix} É bom`, prevText: "", nextText: "" }));

it("cancelamento de conjunto impede publicação antiga; teto 100 e uma tentativa por conjunto", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "cleanup-notes-")), controller = new AbortController();
  let entered!: () => void, release!: () => void; const start = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  let calls = 0; const signals: AbortSignal[] = [];
  const decide = vi.fn<FillerObserveClient["decide"]>(async (req, signal) => {
    signals.push(signal); if (++calls === 1) { entered(); await gate; }
    return { model: "configured", answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul" as const, noul: 0.8 }])) };
  });
  const published: FillerNote[][] = [], warn = vi.fn();
  const notes = cleanupFillerNotes({ workDir, model: "configured", client: { decide }, signal: controller.signal, publish: n => published.push(n), warn });
  notes.update(items(1)); await start;
  notes.update(items(102, "b")); expect(signals[0]!.aborted).toBe(true); release();
  await vi.waitFor(() => expect(published.at(-1)).toHaveLength(100));
  expect(published.at(-1)!.every(n => n.candidateId.startsWith("b"))).toBe(true);
  expect(decide).toHaveBeenCalledTimes(6); expect(warn).toHaveBeenCalledWith(expect.stringContaining("2 cacoetes"));
  const disk = JSON.parse(await readFile(join(workDir, "fillers-notes.json"), "utf8")); expect(disk.notes).toHaveLength(100);
  notes.update(items(102, "b")); expect(decide).toHaveBeenCalledTimes(6);
  await notes.close();
});
it("falha 429 não tem retry automático nem nova tentativa ao repetir conjunto", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "cleanup-notes-"));
  const decide = vi.fn<FillerObserveClient["decide"]>().mockRejectedValue(new Error("429 simulado"));
  const publish = vi.fn(); const notes = cleanupFillerNotes({ workDir, model: "configured", client: { decide }, signal: new AbortController().signal, publish, warn: vi.fn() });
  notes.update(items(1)); await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ score: null, decisionFailure: "falha na decisão Jev" })]));
  notes.update(items(1)); expect(decide).toHaveBeenCalledTimes(1); await notes.close();
  await expect(readFile(join(workDir, "fillers-notes.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

const successful = () => vi.fn<FillerObserveClient["decide"]>(async req => ({ model: req.model!,
  answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul" as const, noul: 0.8 }])) }));

it("sem cliente não publica tentativa nem cache; uma sessão configurada pontua falha antiga", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "cleanup-notes-config-")), selected = items(1);
  const publish = vi.fn(), pending = vi.fn();
  const none = cleanupFillerNotes({ workDir, model: "configured", signal: new AbortController().signal, publish, pending, warn: vi.fn() });
  none.update(selected); await none.close();
  expect(publish).toHaveBeenCalledExactlyOnceWith([]); expect(pending).toHaveBeenLastCalledWith(false);
  await expect(readFile(join(workDir, "fillers-notes.json"))).rejects.toMatchObject({ code: "ENOENT" });
  // Reproduz também um cache produzido pela versão anterior, com falha persistida.
  await writeFile(join(workDir, "fillers-notes.json"), JSON.stringify({ notes: [{ candidateId: "a0", key: fillerNoteKey(selected[0]!, "configured"),
    model: "configured", questionVersion: FILLER_JEV_QUESTION_VERSION, score: null, decisionFailure: "Jev sem cliente configurado" }] }));
  const decide = successful();
  const configured = cleanupFillerNotes({ workDir, model: "configured", client: { decide }, signal: new AbortController().signal, publish, pending, warn: vi.fn() });
  configured.update(selected);
  await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ score: 0.8 })]));
  expect(decide).toHaveBeenCalledTimes(1); expect(pending).toHaveBeenLastCalledWith(false);
  expect(JSON.parse(await readFile(join(workDir, "fillers-notes.json"), "utf8")).notes).toEqual([expect.objectContaining({ score: 0.8 })]);
  await configured.close();
});

it("selecionar 4 → 3 → 4 preserva notas; crescer só pontua a nova; contexto e catálogo podam", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "cleanup-notes-cache-")), decide = successful(), publish = vi.fn(), pending = vi.fn();
  const notes = cleanupFillerNotes({ workDir, model: "configured", client: { decide }, signal: new AbortController().signal, publish, pending, warn: vi.fn() });
  const run = async (active: FillerObserveItem[], catalog: FillerObserveItem[]) => {
    const before = publish.mock.calls.length; notes.update(active, catalog);
    await vi.waitFor(() => { expect(publish.mock.calls.length).toBeGreaterThanOrEqual(before + 3); expect(pending).toHaveBeenLastCalledWith(false); });
  };
  await run(items(4), items(5)); expect(decide).toHaveBeenCalledTimes(1);
  await run(items(3), items(5)); expect(decide).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(workDir, "fillers-notes.json"), "utf8")).notes).toHaveLength(4);
  await run(items(4), items(5)); expect(decide).toHaveBeenCalledTimes(1);
  await run(items(5), items(5)); expect(Object.keys(decide.mock.calls[1]![0].questions)).toEqual(["a4"]);
  const changed = items(5); changed[0]!.nextText = "contexto novo";
  await run(changed, changed); expect(Object.keys(decide.mock.calls[2]![0].questions)).toEqual(["a0"]);
  const disk = JSON.parse(await readFile(join(workDir, "fillers-notes.json"), "utf8")).notes as FillerNote[];
  expect(disk).toHaveLength(5); expect(disk.filter(n => n.candidateId === "a0").map(n => n.key)).toEqual([fillerNoteKey(changed[0]!, "configured")]);
  await run(changed.slice(0, 2), changed.slice(0, 2));
  expect(JSON.parse(await readFile(join(workDir, "fillers-notes.json"), "utf8")).notes).toHaveLength(2);
  await notes.close();
  const other = cleanupFillerNotes({ workDir, model: "new-model", client: { decide }, signal: new AbortController().signal, publish, pending, warn: vi.fn() });
  other.update(changed.slice(0, 2)); await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith([
    expect.objectContaining({ model: "new-model" }), expect.objectContaining({ model: "new-model" })]));
  expect(decide).toHaveBeenCalledTimes(4);
  expect(JSON.parse(await readFile(join(workDir, "fillers-notes.json"), "utf8")).notes.every((n: FillerNote) => n.model === "new-model")).toBe(true);
  await other.close();
});

it("notas já em cache não consomem o teto de 100 pendentes", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "cleanup-notes-limit-")), selected = items(102), publish = vi.fn(), pending = vi.fn(), warn = vi.fn();
  await writeFile(join(workDir, "fillers-notes.json"), JSON.stringify({ notes: selected.slice(0, 2).map(item => ({
    candidateId: item.candidate.id, key: fillerNoteKey(item, "configured"), model: "configured", questionVersion: FILLER_JEV_QUESTION_VERSION, score: 0.8 })) }));
  const decide = successful(), notes = cleanupFillerNotes({ workDir, model: "configured", client: { decide }, signal: new AbortController().signal, publish, pending, warn });
  notes.update(selected); await vi.waitFor(() => expect(publish.mock.calls.at(-1)![0]).toHaveLength(102));
  expect(decide).toHaveBeenCalledTimes(5);
  expect(decide.mock.calls.flatMap(([req]) => Object.keys(req.questions))).toEqual(selected.slice(2).map(i => i.candidate.id));
  expect(warn.mock.calls.every(([s]) => !s.includes("excedem"))).toBe(true); await notes.close();
});
