import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TypeSafeHttpError, type TypeSafeRequest } from "@decupa/typesafe";
import {
  createFillerObserveClient, fillerNoteKey, matchingFillerNote, publishFillerNotes, scoreAmbiguous,
  type FillerObserveItem,
} from "./fillers-observe.ts";

function item(i: number): FillerObserveItem {
  return { candidate: { id: `ambiguous:w${i}`, category: "ambiguous", token: "é", wordIds: [`w${i}`],
    start: i, end: i + 0.1, rule: "contexto", verdict: "signal" },
  unitText: `É importante ${i}`, prevText: "Antes.", nextText: "Depois." };
}

function answers(req: TypeSafeRequest) {
  return { model: "fake", answers: Object.fromEntries(Object.keys(req.questions).map(id => [id, { type: "noul" as const, noul: 0.9 }])) };
}

it("modelo configurado viaja na requisição e na identidade da nota", async () => {
  const model = "jev-modelo-de-decision-json";
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as TypeSafeRequest;
    expect(request.model).toBe(model);
    return new Response(JSON.stringify(answers(request)));
  });
  const client = createFillerObserveClient({ apiKey: "fake", model, fetchImpl });
  const candidate = item(1);
  const result = await scoreAmbiguous(client, [candidate], { model, signal: new AbortController().signal });
  expect(result.notes[0]).toMatchObject({ model, key: fillerNoteKey(candidate, model), score: 0.9 });
  expect(matchingFillerNote(result.notes[0], candidate, model)).toEqual(result.notes[0]);
  expect(matchingFillerNote(result.notes[0], candidate, "jev-latest")).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("model ausente ou vazio falha alto em vez de escolher um default", async () => {
  expect(() => createFillerObserveClient({ apiKey: "fake" } as Parameters<typeof createFillerObserveClient>[0]))
    .toThrow(/model.*obrigatório/);
  expect(() => fillerNoteKey(item(1), "")).toThrow(/model.*obrigatório/);
  await expect(scoreAmbiguous(undefined, [item(1)], { model: "", signal: new AbortController().signal }))
    .rejects.toThrow(/model.*obrigatório/);
});

it("observe só pontua ambíguos, em lotes de 20, com teto de 100 e sem aplicar", async () => {
  const items = Array.from({ length: 105 }, (_, i) => item(i));
  const hard = item(106); hard.candidate.category = "hesitation"; items.push(hard);
  const decide = vi.fn(async (req: TypeSafeRequest) => answers(req));
  const signal = new AbortController().signal;
  const before = structuredClone(items);
  const result = await scoreAmbiguous({ decide }, items, { signal, max: 200, model: "fake" });
  expect(result).toMatchObject({ eligible: 105, excess: 5 });
  expect(result.notes).toHaveLength(100);
  expect(decide).toHaveBeenCalledTimes(5);
  for (const [request, passedSignal] of decide.mock.calls as unknown as [TypeSafeRequest, AbortSignal][]) {
    expect(Object.keys(request.questions)).toHaveLength(20);
    expect(passedSignal).toBe(signal);
    expect(Object.values(request.questions)[0]).toMatchObject({ type: "noul", instructions: expect.stringContaining("Na dúvida, não") });
  }
  expect(result.notes.every(note => note.score === 0.9)).toBe(true);
  expect(items).toEqual(before);
});

it("respeita max menor e conta o excedente", async () => {
  const decide = vi.fn(async (req: TypeSafeRequest) => answers(req));
  const result = await scoreAmbiguous({ decide }, [item(1), item(2)], { model: "configured-jev", signal: new AbortController().signal, max: 1 });
  expect(result.notes).toHaveLength(1);
  expect(result.excess).toBe(1);
  await expect(scoreAmbiguous({ decide }, [], { model: "configured-jev", signal: new AbortController().signal, max: NaN })).rejects.toThrow(/inteiro/);
});

it.each([401, 422, 429, 529, 500])("HTTP %s vira sem nota, sem repetir o lote", async status => {
  const decide = vi.fn(async () => { throw new TypeSafeHttpError(status, "não vaza detalhes"); });
  const result = await scoreAmbiguous({ decide }, [item(1)], { model: "configured-jev", signal: new AbortController().signal });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(result.notes[0]).toMatchObject({ score: null, decisionFailure: [401, 422].includes(status)
    ? "configuração do Jev" : [429, 529].includes(status) ? "Jev indisponível" : "falha na decisão Jev" });
});

it.each([429, 529])("cliente observe faz só 1 fetch mesmo com HTTP %s", async status => {
  const fetchImpl = vi.fn(async () => new Response('{"error":"indisponível"}', { status }));
  const client = createFillerObserveClient({ apiKey: "fake", model: "configured-jev", fetchImpl, maxRetries: 5 });
  const result = await scoreAmbiguous(client, [item(1)], { model: "configured-jev", signal: new AbortController().signal });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.notes[0]!.score).toBeNull();
});

it("uma falha não impede a única tentativa do lote seguinte", async () => {
  const decide = vi.fn(async (req: TypeSafeRequest) => answers(req));
  decide.mockRejectedValueOnce(new Error("falhou"));
  const result = await scoreAmbiguous({ decide }, Array.from({ length: 21 }, (_, i) => item(i)), { model: "configured-jev", signal: new AbortController().signal });
  expect(decide).toHaveBeenCalledTimes(2);
  expect(result.notes.slice(0, 20).every(note => note.score === null)).toBe(true);
  expect(result.notes[20]!.score).toBe(0.9);
});

it("resposta inválida deixa todo o lote sem nota", async () => {
  const decide = vi.fn(async (req: TypeSafeRequest) => {
    const result = answers(req); result.answers[Object.keys(req.questions)[0]!]!.noul = NaN; return result;
  });
  const result = await scoreAmbiguous({ decide }, [item(1), item(2)], { model: "configured-jev", signal: new AbortController().signal });
  expect(result.notes.every(note => note.score === null && note.decisionFailure === "falha na decisão Jev")).toBe(true);
});

it("sem cliente não chama provedor e registra o motivo", async () => {
  const result = await scoreAmbiguous(undefined, [item(1)], { model: "configured-jev", signal: new AbortController().signal });
  expect(result.notes[0]).toMatchObject({ score: null, decisionFailure: "Jev sem cliente configurado" });
});

it("cancelamento antes ou durante lote encerra sem iniciar o próximo", async () => {
  const controller = new AbortController();
  const decide = vi.fn(async (req: TypeSafeRequest) => { controller.abort(); return answers(req); });
  await expect(scoreAmbiguous({ decide }, Array.from({ length: 21 }, (_, i) => item(i)), { model: "configured-jev", signal: controller.signal })).rejects.toThrow();
  expect(decide).toHaveBeenCalledTimes(1);
  await expect(scoreAmbiguous({ decide }, [item(1)], { model: "configured-jev", signal: controller.signal })).rejects.toThrow();
  expect(decide).toHaveBeenCalledTimes(1);
});

it("nota depende do contexto inteiro, do modelo e da versão da pergunta", async () => {
  const original = item(1);
  const { notes: [note] } = await scoreAmbiguous({ decide: async req => answers(req) }, [original], { model: "configured-jev", signal: new AbortController().signal });
  expect(matchingFillerNote(note, original, "configured-jev")).toEqual(note);
  for (const key of ["unitText", "prevText", "nextText"] as const) {
    const changed = { ...original, [key]: "mudou" };
    expect(fillerNoteKey(changed, "configured-jev")).not.toBe(note!.key);
    expect(matchingFillerNote(note, changed, "configured-jev")).toBeNull();
  }
  expect(matchingFillerNote(note, original, "outro-modelo")).toBeNull();
  expect(matchingFillerNote({ ...note, questionVersion: "antiga" }, original, "configured-jev")).toBeNull();
  expect(matchingFillerNote({ ...note, score: 2 }, original, "configured-jev")).toBeNull();
});

it("publica fillers-notes.json atomicamente e respeita cancelamento antes de gravar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fillers-notes-"));
  try {
    const { notes } = await scoreAmbiguous(undefined, [item(1)], { model: "configured-jev", signal: new AbortController().signal });
    await publishFillerNotes(directory, notes, new AbortController().signal);
    expect(JSON.parse(await readFile(join(directory, "fillers-notes.json"), "utf8"))).toEqual({ notes });
    const controller = new AbortController(); controller.abort();
    await expect(publishFillerNotes(directory, [], controller.signal)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(directory, "fillers-notes.json"), "utf8"))).toEqual({ notes });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
