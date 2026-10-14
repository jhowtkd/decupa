import { createHash } from "node:crypto";
import { join } from "node:path";
import { publishAtomic } from "@decupa/cache";
import {
  TypeSafeClient, TypeSafeHttpError,
  type TypeSafeClientOptions, type TypeSafeRequest, type TypeSafeResult,
} from "@decupa/typesafe";
import type { FillerCandidate } from "./fillers.ts";

export const FILLER_JEV_MAX_PER_GENERATION = 100;
export const FILLER_JEV_BATCH_SIZE = 20;
export const FILLER_JEV_QUESTION_VERSION = "fillers-observe:1";

export type FillerObserveClient = {
  decide(req: TypeSafeRequest, signal: AbortSignal): Promise<TypeSafeResult>;
};
export type FillerObserveItem = {
  candidate: FillerCandidate; unitText: string; prevText: string; nextText: string;
};
export type FillerNote = {
  candidateId: string; key: string; model: string; questionVersion: string;
  score: number | null; decisionFailure?: string;
};
export type FillerObserveResult = {
  notes: FillerNote[]; eligible: number; excess: number;
};

/** O cliente da preparação permite retry; observe tem uma única tentativa. */
export function createFillerObserveClient(opts: TypeSafeClientOptions & { model: string }): FillerObserveClient {
  configuredModel(opts.model);
  return new TypeSafeClient({ ...opts, maxRetries: 0 });
}

function configuredModel(model: string): void {
  if (typeof model !== "string" || !model.trim()) throw Error("cacoetes: model da configuração de decisão é obrigatório");
}

export function fillerNoteKey(item: FillerObserveItem, model: string): string {
  configuredModel(model);
  return createHash("sha256").update(JSON.stringify([
    item.candidate.id, item.unitText, item.prevText, item.nextText, model, FILLER_JEV_QUESTION_VERSION,
  ])).digest("hex");
}

/** Uma nota antiga só vale se todo o contexto da pergunta ainda for igual. */
export function matchingFillerNote(raw: unknown, item: FillerObserveItem, model: string): FillerNote | null {
  if (!raw || typeof raw !== "object") return null;
  const note = raw as FillerNote;
  if (note.candidateId !== item.candidate.id || note.key !== fillerNoteKey(item, model)
    || note.model !== model || note.questionVersion !== FILLER_JEV_QUESTION_VERSION
    || (note.score !== null && (typeof note.score !== "number" || !Number.isFinite(note.score) || note.score < 0 || note.score > 1))
    || (note.decisionFailure !== undefined && typeof note.decisionFailure !== "string")) return null;
  return { candidateId: note.candidateId, key: note.key, model, questionVersion: note.questionVersion,
    score: note.score, ...(note.decisionFailure ? { decisionFailure: note.decisionFailure } : {}) };
}

function decisionFailure(error: unknown): string {
  if (error instanceof TypeSafeHttpError) {
    if ([401, 422].includes(error.status)) return "configuração do Jev";
    if ([429, 529].includes(error.status)) return "Jev indisponível";
  }
  return "falha na decisão Jev";
}

export async function scoreAmbiguous(
  client: FillerObserveClient | undefined,
  items: FillerObserveItem[],
  opts: { signal: AbortSignal; max?: number; model: string },
): Promise<FillerObserveResult> {
  opts.signal.throwIfAborted();
  const max = opts.max ?? FILLER_JEV_MAX_PER_GENERATION;
  if (!Number.isSafeInteger(max) || max < 0) throw Error("cacoetes: max precisa ser inteiro não negativo");
  const model = opts.model;
  configuredModel(model);
  const eligible = items.filter(item => item.candidate.category === "ambiguous");
  // IDs repetidos colidiriam nas questions. Ocorrências e gerações são
  // responsabilidade do fluxo, que chama esta função com uma lista única.
  if (new Set(eligible.map(item => item.candidate.id)).size !== eligible.length) throw Error("cacoetes: candidateId duplicado nas notas");
  const selected = eligible.slice(0, Math.min(max, FILLER_JEV_MAX_PER_GENERATION));
  const notes: FillerNote[] = [];
  const note = (item: FillerObserveItem, score: number | null, failure?: string): FillerNote => ({
    candidateId: item.candidate.id, key: fillerNoteKey(item, model), model,
    questionVersion: FILLER_JEV_QUESTION_VERSION, score,
    ...(failure ? { decisionFailure: failure } : {}),
  });
  for (let offset = 0; offset < selected.length; offset += FILLER_JEV_BATCH_SIZE) {
    const batch = selected.slice(offset, offset + FILLER_JEV_BATCH_SIZE);
    if (!client) {
      notes.push(...batch.map(item => note(item, null, "Jev sem cliente configurado")));
      continue;
    }
    try {
      opts.signal.throwIfAborted();
      const result = await client.decide({
        model,
        state: { candidates: batch },
        questions: Object.fromEntries(batch.map(item => [item.candidate.id, {
          type: "noul" as const,
          instructions: `Candidato ${item.candidate.id}: esta palavra é cacoete dispensável aqui? Na dúvida, não.`,
          criteria: { true: "Cacoete dispensável no contexto", false: "Preservar sentido ou dúvida" },
        }])),
      }, opts.signal);
      opts.signal.throwIfAborted();
      const scores = batch.map(item => {
        const answer = result.answers[item.candidate.id];
        if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw Error("resposta Jev inválida");
        return answer.noul;
      });
      notes.push(...batch.map((item, i) => note(item, scores[i]!)));
    } catch (error) {
      opts.signal.throwIfAborted();
      notes.push(...batch.map(item => note(item, null, decisionFailure(error))));
    }
  }
  return { notes, eligible: eligible.length, excess: eligible.length - selected.length };
}

export async function publishFillerNotes(directory: string, notes: readonly FillerNote[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await publishAtomic(join(directory, "fillers-notes.json"), `${JSON.stringify({ notes }, null, 2)}\n`);
}
