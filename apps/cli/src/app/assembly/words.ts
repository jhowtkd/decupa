import { energyEnvelope, snapCut } from "@decupa/acoustics";
import type {
  EditAction,
  Project,
  Scene,
  SourceRange,
  SpeechTake,
  Word,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Une intervalos sobrepostos/adjacentes e ordena por início. */
export function normalizeRanges(ranges: SourceRange[]): SourceRange[] {
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRange[] = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** Subtrai `cuts` de `base`; ambos normalizados na saída. */
export function subtractRanges(base: SourceRange[], cuts: SourceRange[]): SourceRange[] {
  let current = normalizeRanges(base);
  for (const cut of normalizeRanges(cuts)) {
    const next: SourceRange[] = [];
    for (const range of current) {
      if (cut.end <= range.start || cut.start >= range.end) {
        next.push(range);
        continue;
      }
      if (cut.start > range.start) next.push({ start: range.start, end: cut.start });
      if (cut.end < range.end) next.push({ start: cut.end, end: range.end });
    }
    current = next;
  }
  return current;
}

/**
 * Seleção canônica de mídia de um take: o intervalo do take menos as
 * exclusões, em intervalos semiabertos normalizados e sem sobreposição.
 */
export function retainedRanges(take: SpeechTake): SourceRange[] {
  const bounds = [{ start: take.start, end: take.end }];
  const inside = take.removed
    .map((range) => ({
      start: Math.max(range.start, take.start),
      end: Math.min(range.end, take.end),
    }))
    .filter((range) => range.start < range.end);
  return subtractRanges(bounds, inside);
}

/**
 * Catálogo efetivo de palavras da fonte: o reconhecido com as correções
 * `aligned` substituídas no intervalo corrigido. Correções `pending`/`error`
 * não alteram o catálogo — o original segue recuperável.
 */
export function effectiveWords(project: Project, sourceId: string): Word[] {
  const analysis = project.analyses.find((item) => item.sourceId === sourceId);
  if (!analysis) return [];
  let words = [...analysis.words];
  for (const correction of project.corrections) {
    if (correction.sourceId !== sourceId) continue;
    if (correction.status !== "aligned" || correction.words.length === 0) continue;
    words = words.filter((word) => !(word.start < correction.end && correction.start < word.end));
    words.push(...correction.words);
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

function findScene(project: Project, sceneId: string): Scene {
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`cena não encontrada: ${sceneId}`);
  return scene;
}

function findTake(scene: Scene, takeId: string): SpeechTake {
  const take = scene.takes.find((item) => item.id === takeId);
  if (!take) throw new Error(`take ${takeId} não encontrado na cena ${scene.id}`);
  return take;
}

function findWords(project: Project, wordIds: string[], sourceId: string): Word[] {
  const own = new Map(effectiveWords(project, sourceId).map((word) => [word.id, word]));
  const elsewhere = new Set<string>();
  for (const analysis of project.analyses) {
    if (analysis.sourceId === sourceId) continue;
    for (const word of effectiveWords(project, analysis.sourceId)) elsewhere.add(word.id);
  }
  return wordIds.map((id) => {
    const word = own.get(id);
    if (word) return word;
    if (elsewhere.has(id)) throw new Error(`palavra ${id} de outra fonte (não da fonte ${sourceId})`);
    throw new Error(`palavra não encontrada na fonte ${sourceId}: ${id}`);
  });
}

/**
 * Intervalo de corte de uma palavra: limites acústicos persistidos quando
 * existem, senão as fronteiras da palavra — sempre preso aos vizinhos para
 * nunca cortar dentro da palavra ao lado.
 */
export function wordCutInterval(
  word: Word,
  prev?: Word,
  next?: Word,
): SourceRange {
  const prevEnd = prev ? (prev.cutEnd ?? prev.end) : Number.NEGATIVE_INFINITY;
  const nextStart = next ? (next.cutStart ?? next.start) : Number.POSITIVE_INFINITY;
  return {
    start: Math.min(Math.max(word.cutStart ?? word.start, prevEnd), word.start),
    end: Math.max(Math.min(word.cutEnd ?? word.end, nextStart), word.end),
  };
}

/**
 * Refina cortes pelo envelope de energia do trecho: empurra cada fronteira
 * para o ponto de menor energia próximo (snapCut existente) e prende aos
 * vizinhos e aos limites. Puro dado o PCM; o chamador garante que o PCM
 * corresponde ao trecho das palavras.
 */
export function snapWordCuts(
  pcm: Int16Array,
  words: { start: number; end: number }[],
  opts: { windowMs?: number } = {},
): SourceRange[] {
  const envelope = energyEnvelope(pcm);
  const snapped = words.map((word) => ({
    start: snapCut({ envelope, targetMs: word.start * 1000, windowMs: opts.windowMs }).ms / 1000,
    end: snapCut({ envelope, targetMs: word.end * 1000, windowMs: opts.windowMs }).ms / 1000,
  }));
  return snapped.map((cut, i) => {
    const word = words[i]!;
    const prevEnd = i > 0 ? snapped[i - 1]!.end : Number.NEGATIVE_INFINITY;
    const nextStart = i < snapped.length - 1 ? snapped[i + 1]!.start : Number.POSITIVE_INFINITY;
    return {
      start: Math.min(Math.max(cut.start, prevEnd), word.start),
      end: Math.max(Math.min(cut.end, nextStart), word.end),
    };
  });
}

function wordIntervalsInTake(
  words: Word[],
  ordered: Word[],
  take: SpeechTake,
): SourceRange[] {
  const byId = new Map(ordered.map((word, i) => [word.id, i]));
  return words.map((word) => {
    const i = byId.get(word.id)!;
    const interval = wordCutInterval(word, ordered[i - 1], ordered[i + 1]);
    if (interval.start < take.start || interval.end > take.end) {
      throw new Error(`palavra ${word.id} fora do take ${take.id}`);
    }
    return interval;
  });
}

function overlaps(range: SourceRange, list: SourceRange[]): boolean {
  return list.some((item) => range.start < item.end && item.start < range.end);
}

function withTake(project: Project, sceneId: string, takeId: string, next: SpeechTake): Project {
  return {
    ...project,
    scenes: project.scenes.map((scene) => scene.id !== sceneId ? scene : {
      ...scene,
      takes: scene.takes.map((take) => take.id !== takeId ? take : next),
    }),
  };
}

function invalidatePreview(project: Project): Project {
  return {
    ...project,
    revision: project.revision + 1,
    assembly: { ...project.assembly, revision: project.revision + 1 },
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

function applyRemoveRestore(
  project: Project,
  action: { sceneId: string; takeId: string; wordIds: string[] },
  mode: "remove" | "restore",
): Project {
  if (action.wordIds.length === 0) throw new Error("nenhuma palavra selecionada");
  const scene = findScene(project, action.sceneId);
  const take = findTake(scene, action.takeId);
  const ordered = effectiveWords(project, take.sourceId);
  const words = findWords(project, action.wordIds, take.sourceId);
  const intervals = wordIntervalsInTake(words, ordered, take);
  if (mode === "remove") {
    if (intervals.some((range) => overlaps(range, take.protected))) {
      throw new Error("trecho protegido: remova a proteção antes de cortar");
    }
    const removed = normalizeRanges([...take.removed, ...intervals]);
    return invalidatePreview(withTake(project, scene.id, take.id, { ...take, removed }));
  }
  const before = normalizeRanges(take.removed);
  const after = subtractRanges(before, intervals);
  if (after.length === before.length && after.every((r, i) => r.start === before[i]!.start && r.end === before[i]!.end)) {
    throw new Error("trecho não está removido: nada a restaurar");
  }
  return invalidatePreview(withTake(project, scene.id, take.id, { ...take, removed: after }));
}

function applyProtect(
  project: Project,
  action: { sceneId: string; takeId: string; wordIds: string[] },
  mode: "protect" | "unprotect",
): Project {
  if (action.wordIds.length === 0) throw new Error("nenhuma palavra selecionada");
  const scene = findScene(project, action.sceneId);
  const take = findTake(scene, action.takeId);
  const ordered = effectiveWords(project, take.sourceId);
  const words = findWords(project, action.wordIds, take.sourceId);
  const intervals = wordIntervalsInTake(words, ordered, take);
  if (mode === "protect") {
    const merged = normalizeRanges([...take.protected, ...intervals]);
    return invalidatePreview(withTake(project, scene.id, take.id, { ...take, protected: merged }));
  }
  const before = normalizeRanges(take.protected);
  const after = subtractRanges(before, intervals);
  if (after.length === before.length && after.every((r, i) => r.start === before[i]!.start && r.end === before[i]!.end)) {
    throw new Error("trecho não está protegido: nada a liberar");
  }
  return invalidatePreview(withTake(project, scene.id, take.id, { ...take, protected: after }));
}

function applyCorrect(
  project: Project,
  action: { sourceId: string; start: number; end: number; text: string },
): Project {
  const source = project.assembly.sources.find((item) => item.id === action.sourceId);
  if (!source) throw new Error(`fonte não encontrada: ${action.sourceId}`);
  if (!Number.isFinite(action.start) || !Number.isFinite(action.end)
    || !(action.start >= 0 && action.start < action.end && action.end <= source.durationSeconds)) {
    throw new Error("correção com intervalo inválido para a fonte");
  }
  const text = action.text.trim();
  if (text.length === 0) throw new Error("correção com texto vazio");
  // Correções sobrepostas viram um único intervalo pendente com o texto novo.
  const overlapping = project.corrections.filter((item) =>
    item.sourceId === action.sourceId && item.start < action.end && action.start < item.end
  );
  const start = Math.min(action.start, ...overlapping.map((item) => item.start));
  const end = Math.max(action.end, ...overlapping.map((item) => item.end));
  const drop = new Set(overlapping.map((item) => item.id));
  let n = project.corrections.length + 1;
  let id = `c${n}`;
  const taken = new Set(project.corrections.map((item) => item.id));
  while (taken.has(id)) { n += 1; id = `c${n}`; }
  return invalidatePreview({
    ...project,
    corrections: [
      ...project.corrections.filter((item) => !drop.has(item.id)),
      { id, sourceId: action.sourceId, start, end, text, status: "pending" as const, words: [] },
    ],
  });
}

function applyInclude(
  project: Project,
  action: { sceneId: string; sourceId: string; wordIds: string[] },
): Project {
  if (action.wordIds.length === 0) throw new Error("nenhuma palavra selecionada");
  const scene = findScene(project, action.sceneId);
  if (!project.assembly.sources.some((item) => item.id === action.sourceId)) {
    throw new Error(`fonte não encontrada: ${action.sourceId}`);
  }
  const ordered = effectiveWords(project, action.sourceId);
  const words = findWords(project, action.wordIds, action.sourceId);
  const intervals = words.map((word) => {
    const i = ordered.findIndex((item) => item.id === word.id);
    return wordCutInterval(word, ordered[i - 1], ordered[i + 1]);
  });
  // Só fala fora da seleção atual: nada do intervalo pode já estar retido.
  const retained = scene.takes
    .filter((take) => take.sourceId === action.sourceId)
    .flatMap((take) => retainedRanges(take));
  for (const interval of intervals) {
    if (overlaps(interval, retained)) {
      throw new Error("trecho já está na montagem: use remover/restaurar");
    }
  }
  const start = Math.min(...intervals.map((item) => item.start));
  const end = Math.max(...intervals.map((item) => item.end));
  const taken = new Set(scene.takes.map((item) => item.id));
  let n = scene.takes.length + 1;
  let id = `${scene.id}-t${n}`;
  while (taken.has(id)) { n += 1; id = `${scene.id}-t${n}`; }
  const take: SpeechTake = { id, sourceId: action.sourceId, speechId: null, start, end, removed: [], protected: [] };
  return invalidatePreview({
    ...project,
    scenes: project.scenes.map((item) => item.id !== scene.id ? item : {
      ...item,
      takes: [...item.takes, take],
    }),
  });
}

function applyMoveScene(project: Project, sceneId: string, direction: "up" | "down"): Project {
  const i = project.scenes.findIndex((item) => item.id === sceneId);
  if (i < 0) throw new Error(`cena não encontrada: ${sceneId}`);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= project.scenes.length) throw new Error(`cena ${sceneId} já está no extremo`);
  const scenes = [...project.scenes];
  [scenes[i], scenes[j]] = [scenes[j]!, scenes[i]!];
  return invalidatePreview({ ...project, scenes });
}

function applyDeleteScene(project: Project, sceneId: string): Project {
  findScene(project, sceneId);
  return invalidatePreview({
    ...project,
    scenes: project.scenes.filter((item) => item.id !== sceneId),
  });
}

/**
 * Aplica uma ação editorial de forma pura: valida tudo antes de gravar,
 * incrementa a revisão e invalida aprovações/prévia atual. O artefato anterior
 * segue no disco (stale por revisão) para exibição como prévia anterior.
 */
export function applyTextEdit(project: Project, action: EditAction): Project {
  switch (action.type) {
    case "remove": return applyRemoveRestore(project, action, "remove");
    case "restore": return applyRemoveRestore(project, action, "restore");
    case "protect": return applyProtect(project, action, "protect");
    case "unprotect": return applyProtect(project, action, "unprotect");
    case "correct": return applyCorrect(project, action);
    case "include": return applyInclude(project, action);
    case "move-scene": return applyMoveScene(project, action.sceneId, action.direction);
    case "delete-scene": return applyDeleteScene(project, action.sceneId);
  }
}

export type AlignmentOutcome =
  | { words: { text: string; start: number; end: number; confidence: number | null; cutStart?: number; cutEnd?: number }[] }
  | { error: string };

/**
 * Publica o resultado do alinhamento de uma correção pendente. Não cria
 * revisão nova: é a conclusão da edição que registrou o pending. A seleção
 * de mídia (takes) permanece idêntica; correção obsoleta (outra edição ou
 * undo no meio) deve ser descartada pela rota via CAS antes de chamar aqui.
 */
export function settleCorrection(
  project: Project,
  correctionId: string,
  outcome: AlignmentOutcome,
): Project {
  const correction = project.corrections.find((item) => item.id === correctionId);
  if (!correction) throw new Error(`correção não encontrada: ${correctionId}`);
  if (correction.status !== "pending") {
    throw new Error(`correção ${correctionId} já resolvida: ${correction.status}`);
  }
  const source = project.assembly.sources.find((item) => item.id === correction.sourceId);
  if (!source) throw new Error(`fonte não encontrada: ${correction.sourceId}`);
  if ("error" in outcome) {
    return {
      ...project,
      corrections: project.corrections.map((item) => item.id !== correctionId ? item : {
        ...item,
        status: "error" as const,
        words: [],
        error: outcome.error,
      }),
    };
  }
  if (outcome.words.length === 0) throw new Error("alinhamento sem palavras");
  const words: Word[] = outcome.words.map((word, i) => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)
      || !(word.start >= correction.start && word.end <= correction.end && word.start < word.end)) {
      throw new Error(`palavra alinhada fora do intervalo da correção ${correctionId}`);
    }
    return {
      id: `${correction.sourceId}:${source.sha256}:c:${correctionId}:w${String(i).padStart(6, "0")}`,
      sourceId: correction.sourceId,
      text: word.text,
      confidence: word.confidence,
      start: word.start,
      end: word.end,
      ...(word.cutStart !== undefined ? { cutStart: word.cutStart } : {}),
      ...(word.cutEnd !== undefined ? { cutEnd: word.cutEnd } : {}),
    };
  });
  return {
    ...project,
    corrections: project.corrections.map((item) => item.id !== correctionId ? item : {
      ...item,
      status: "aligned" as const,
      words,
      error: undefined,
    }),
  };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0
    || !value.every((item): item is string => typeof item === "string" && item.length > 0)) {
    throw new Error(`${label} precisa ser uma lista não vazia de ids`);
  }
  return value;
}

/** Valida a união discriminada de edição vinda do HTTP antes de gravar. */
export function parseEditAction(raw: unknown): EditAction {
  if (!isRecord(raw)) throw new Error("ação de edição precisa ser um objeto");
  switch (raw.type) {
    case "remove":
    case "restore":
    case "protect":
    case "unprotect":
      return {
        type: raw.type,
        sceneId: nonEmptyId(raw.sceneId, "sceneId"),
        takeId: nonEmptyId(raw.takeId, "takeId"),
        wordIds: stringList(raw.wordIds, "wordIds"),
      };
    case "correct": {
      const start = raw.start;
      const end = raw.end;
      if (typeof start !== "number" || typeof end !== "number"
        || !Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) {
        throw new Error("correção com intervalo inválido");
      }
      if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
        throw new Error("correção com texto vazio");
      }
      return { type: "correct", sourceId: nonEmptyId(raw.sourceId, "sourceId"), start, end, text: raw.text };
    }
    case "include":
      return {
        type: "include",
        sceneId: nonEmptyId(raw.sceneId, "sceneId"),
        sourceId: nonEmptyId(raw.sourceId, "sourceId"),
        wordIds: stringList(raw.wordIds, "wordIds"),
      };
    case "move-scene":
      if (raw.direction !== "up" && raw.direction !== "down") {
        throw new Error("direção inválida para mover cena");
      }
      return { type: "move-scene", sceneId: nonEmptyId(raw.sceneId, "sceneId"), direction: raw.direction };
    case "delete-scene":
      return { type: "delete-scene", sceneId: nonEmptyId(raw.sceneId, "sceneId") };
    default:
      throw new Error(`ação de edição desconhecida: ${String(raw.type)}`);
  }
}

function nonEmptyId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} inválido`);
  }
  return value;
}
