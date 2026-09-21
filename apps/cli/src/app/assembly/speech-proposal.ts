/**
 * Ajuste localizado de fala (#64): o usuário seleciona uma fala concreta
 * (sourceId + speechId) e pede uma alteração; o modelo propõe cortes
 * SOMENTE por IDs de palavra dentro do escopo. A comparação antes/depois
 * mostra os cortes e o impacto de duração; aceitar aplica via o mecanismo
 * de revisão existente (bump + histórico + invalidação de aprovação) e
 * proposta com baseRevision antiga é recusada na chegada.
 */
import { randomUUID } from "node:crypto";
import { parseModelJson, requestValidated } from "./model-response.ts";
import { compileScenes } from "./scenes.ts";
import type { Analysis, Project, Scene, SourceRange, SpeechTake, Word } from "./types.ts";
import {
  applySpeechCuts,
  effectiveWords,
  normalizeRanges,
  retainedRanges,
  subtractRanges,
  wordCutInterval,
} from "./words.ts";

export type SpeechCut = {
  start: number;
  end: number;
  wordIds: string[];
  reason?: string;
};

/** Proposta limitada a uma fala: nunca toca outras fontes nem outros takes. */
export type SpeechProposal = {
  id: string;
  baseRevision: number;
  scope: { sourceId: string; speechId: string; sceneIds: string[] };
  request: string;
  cuts: SpeechCut[];
  /** Cortes pedidos que cobriam trecho protegido — contados, não aplicados. */
  skippedProtected: number;
  changedTakeIds: string[];
  before: { durationSeconds: number; text: string };
  after: { durationSeconds: number; text: string };
};

export type SpeechScope = {
  speech: { id: string; sourceId: string; start: number; end: number; text: string };
  words: Word[];
  takes: { scene: Scene; take: SpeechTake }[];
};

/** Resolve a fala escolhida; sem escopo válido nada muda na montagem. */
export function speechScope(project: Project, sourceId: string, speechId: string): SpeechScope {
  const analysis: Analysis | undefined = project.analyses.find((item) => item.sourceId === sourceId);
  if (!analysis) throw new Error(`fonte ${sourceId} sem análise`);
  const speech = analysis.speech.find((item) => item.id === speechId);
  if (!speech) throw new Error(`fala ${speechId} não encontrada na fonte ${sourceId}`);
  const words = effectiveWords(project, sourceId)
    .filter((word) => word.start < speech.end && word.end > speech.start);
  const takes: { scene: Scene; take: SpeechTake }[] = [];
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      if (take.speechId === speechId && take.sourceId === sourceId) takes.push({ scene, take });
    }
  }
  if (takes.length === 0) throw new Error("fala selecionada não está na montagem");
  return { speech, words, takes };
}

type RawCut = { wordIds: string[]; reason?: string };

const rangesDuration = (ranges: SourceRange[]): number =>
  ranges.reduce((total, range) => total + (range.end - range.start), 0);

/**
 * Materializa os cortes do modelo contra o escopo: cada wordId tem que ser
 * da fala escolhida (fora do escopo → recusa), o intervalo é clampado aos
 * takes que a usam, e trecho protegido é descontado antes de aplicar.
 */
export function buildSpeechProposal(
  project: Project,
  scopeInput: { sourceId: string; speechId: string },
  request: string,
  rawCuts: RawCut[],
  id = randomUUID(),
): SpeechProposal {
  const scope = speechScope(project, scopeInput.sourceId, scopeInput.speechId);
  const ordered = [...scope.words].sort((a, b) => a.start - b.start || a.end - b.end);
  const byId = new Map(ordered.map((word, index) => [word.id, index]));
  const cuts: SpeechCut[] = [];
  for (const raw of rawCuts) {
    if (!raw.wordIds.length) continue;
    const parts: SourceRange[] = [];
    for (const wordId of raw.wordIds) {
      const index = byId.get(wordId);
      if (index === undefined) {
        throw new Error(`corte fora do escopo: a palavra ${wordId} não é da fala ${scope.speech.id}`);
      }
      parts.push(wordCutInterval(ordered[index]!, ordered[index - 1], ordered[index + 1]));
    }
    const merged = normalizeRanges(parts);
    for (const range of merged) {
      cuts.push({ start: range.start, end: range.end, wordIds: [...raw.wordIds], reason: raw.reason });
    }
  }

  // Aplicação projetada por take: dentro do take, fora dos protegidos e
  // fora do que já está removido.
  let skippedProtected = 0;
  const changedTakeIds: string[] = [];
  let beforeSeconds = 0;
  let afterSeconds = 0;
  for (const { take } of scope.takes) {
    const clipped = cuts
      .map((cut) => ({
        start: Math.max(cut.start, take.start),
        end: Math.min(cut.end, take.end),
      }))
      .filter((range) => range.start < range.end);
    const allowed = subtractRanges(subtractRanges(clipped, take.protected), take.removed);
    skippedProtected += clipped
      .filter((range) => subtractRanges([range], take.protected).length === 0)
      .length;
    if (allowed.length) changedTakeIds.push(take.id);
    beforeSeconds += rangesDuration(retainedRanges(take));
    afterSeconds += rangesDuration(subtractRanges(retainedRanges(take), allowed));
  }

  const cutWordIds = new Set(cuts.flatMap((cut) => cut.wordIds));
  const afterText = scope.words.filter((word) => !cutWordIds.has(word.id)).map((word) => word.text).join(" ");
  return {
    id,
    baseRevision: project.revision,
    scope: {
      sourceId: scope.speech.sourceId,
      speechId: scope.speech.id,
      sceneIds: scope.takes.map(({ scene }) => scene.id),
    },
    request,
    cuts,
    skippedProtected,
    changedTakeIds,
    before: { durationSeconds: beforeSeconds, text: scope.speech.text },
    after: { durationSeconds: afterSeconds, text: afterText },
  };
}

/**
 * Aplica a proposta aceita: recalcula os intervalos contra o estado atual
 * (a guarda de revisão impede divergência), protegidos voltam a ser
 * descontados, e o bump único invalida prévia e aprovação.
 */
export function applySpeechProposal(project: Project, proposal: SpeechProposal): Project {
  if (proposal.baseRevision !== project.revision) {
    throw new Error(`proposta com revisão desatualizada: base ${proposal.baseRevision}, atual ${project.revision}`);
  }
  const scope = speechScope(project, proposal.scope.sourceId, proposal.scope.speechId);
  const updates = scope.takes.map(({ scene, take }) => ({
    sceneId: scene.id,
    takeId: take.id,
    cuts: proposal.cuts
      .map((cut) => ({
        start: Math.max(cut.start, take.start),
        end: Math.min(cut.end, take.end),
      }))
      .filter((range) => range.start < range.end),
  }));
  const next = applySpeechCuts(project, updates);
  if (next === project) return project;
  return { ...next, assembly: { ...compileScenes(next, next.scenes), revision: next.revision } };
}

function parseCuts(raw: unknown): RawCut[] {
  if (typeof raw !== "object" || raw === null) throw new Error("resposta sem objeto de cortes");
  const list = (raw as { cuts?: unknown }).cuts;
  if (!Array.isArray(list)) throw new Error("resposta sem lista 'cuts'");
  return list.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`corte ${index} inválido`);
    const cut = item as { wordIds?: unknown; reason?: unknown };
    if (!Array.isArray(cut.wordIds) || cut.wordIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`corte ${index} sem wordIds`);
    }
    return {
      wordIds: cut.wordIds as string[],
      reason: typeof cut.reason === "string" ? cut.reason : undefined,
    };
  });
}

/**
 * Pede a proposta ao modelo (provedor injetado — mock nos testes): o prompt
 * só contém as palavras da fala escolhida, e a validação recusa qualquer
 * corte fora do escopo.
 */
export async function proposeSpeechAdjustment(
  project: Project,
  scopeInput: { sourceId: string; speechId: string },
  request: string,
  send: (content: unknown[], signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<SpeechProposal> {
  const scope = speechScope(project, scopeInput.sourceId, scopeInput.speechId);
  const content = [{
    type: "text",
    text: [
      "Você propõe cortes localizados em UMA fala de uma montagem de vídeo.",
      `pedido do usuário: ${request}`,
      `fala ${scope.speech.id} (${scope.speech.start}s–${scope.speech.end}s): "${scope.speech.text}"`,
      "palavras do escopo (id, início, fim, texto): "
        + JSON.stringify(scope.words.map((w) => ({ id: w.id, start: w.start, end: w.end, text: w.text }))),
      "responda somente o JSON: {\"cuts\":[{\"wordIds\":[\"<id>\",...],\"reason\":\"por quê\"}]}",
      "só use ids da lista acima; nunca inclua palavra de fora do escopo",
    ].join("\n\n"),
  }];
  const rawCuts = await requestValidated(
    content,
    (parts, requestSignal) => send(parts, requestSignal),
    (text) => parseCuts(parseModelJson(text)),
    signal,
  );
  signal.throwIfAborted();
  return buildSpeechProposal(project, scopeInput, request, rawCuts);
}
