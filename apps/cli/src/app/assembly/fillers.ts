import { createHash } from "node:crypto";
import {
  classifyFillers, FILLER_CATEGORIES, FILLER_AUTO_CATEGORIES, FILLER_MIN_GAP_SECONDS,
  matchingFillerNote, normalizeFillerText,
  type FillerCandidate, type FillerNote, type FillerObserveItem, type FillerToken,
} from "@decupa/triage";
import type { FillerCut, Project, SourceRange, SpeechTake } from "./types.ts";
import { mergeRemoved, overlaps, retainedRanges, subtractRanges } from "./words.ts";
import { createFillerIndex, fillerTakeKey, fillerTargetKey, type FillerIndex } from "./filler-index.ts";

export type FillerTarget = { candidateId: string; sceneId: string; takeId: string };
export type FillerOccurrence = FillerTarget & FillerObserveItem & {
  sourceId: string; sceneNumber: number; state: "cut" | "kept" | "signal" | "abstain" | "absorbed";
  previousGeneration?: boolean; wordTexts: string[]; origin?: "auto" | "user"; reason?: string; note?: FillerNote;
  listen: SourceRange; effective: SourceRange[];
};
export type FillerSnap = { signature: string; selection?: string; transient?: boolean } & ({ range: SourceRange } | { abstain: true; reason: string });
export type FillerSnaps = Record<string, FillerSnap>;
export type FillerReportNotes = { notes?: FillerNote[]; model?: string; excess?: number; snaps?: FillerSnaps; pending?: boolean };
type Scope = { targets?: FillerTarget[]; sceneIds?: string[]; index?: FillerIndex };

/** Separadores vêm do texto inteiro: uma vírgula nunca vira espaço por acidente. */
export function fillerTokens(project: Project, take: SpeechTake, index = createFillerIndex(project)): FillerToken[] {
  return index.tokens(take);
}

export function fillerSnapKey(item: FillerTarget & { candidate: FillerCandidate }): string {
  return `${item.candidateId}:${item.sceneId}:${item.takeId}:${item.candidate.start}:${item.candidate.end}`;
}

/** A assinatura acústica inclui a transcrição do take; uma camada editorial usa só seu entorno. */
export function fillerSignature(project: Project, take: SpeechTake, index = createFillerIndex(project)): string {
  let signature = index.signatures.get(take);
  if (!signature) {
    const source = index.sources.get(take.sourceId);
    signature = JSON.stringify([source?.sha256, source?.path, source?.hasAudio, take.start, take.end, index.tokens(take)]);
    index.signatures.set(take, signature);
  }
  return signature;
}

export function fillerSelectionSignature(project: Project, take: SpeechTake): string {
  return JSON.stringify([take.removed, take.protected, project.assembly.fps]);
}

/** Correções distantes não invalidam a decisão nem deixam as folgas sem dono. */
export function fillerGeneration(project: Project, sourceId: string, wordIds: string[], index = createFillerIndex(project)): string {
  const source = index.source(sourceId), selected = new Set<number>();
  for (const id of wordIds) {
    const i = source.positions.get(id);
    if (i === undefined) return "missing";
    selected.add(i); selected.add(i - 1); selected.add(i + 1);
  }
  return createHash("sha256").update(JSON.stringify([
    index.sources.get(sourceId)?.sha256,
    [...selected].sort((a, b) => a - b).map(i => {
      const w = source.words[i]; return w ? [w.id, w.text, w.start, w.end] : null;
    }),
  ])).digest("hex");
}

export function fillerCutIsCurrent(project: Project, take: SpeechTake, cut: FillerCut, index = createFillerIndex(project)): boolean {
  if (cut.generation !== undefined) return cut.generation === fillerGeneration(project, take.sourceId, cut.wordIds, index);
  const words = index.source(take.sourceId).byId;
  return cut.wordIds.every((id, i) => words.get(id)?.text === cut.wordTexts[i]);
}

export function fillerException(project: Project, wordId: string, text: string): boolean {
  return (project.fillerExceptions ?? []).some(e => e.wordId === wordId && e.text === text);
}

function reportFrom(occurrences: FillerOccurrence[], notes: FillerReportNotes) {
  const groupsByToken = new Map<string, { token: string; label: string; items: FillerOccurrence[] }>();
  let cut = 0, review = 0, removedSeconds = 0;
  for (const item of occurrences) {
    if (item.state === "absorbed") continue;
    let group = groupsByToken.get(item.candidate.token);
    if (!group) { group = { token: item.candidate.token, label: item.wordTexts[0]!, items: [] }; groupsByToken.set(group.token, group); }
    group.items.push(item);
    if (item.state === "cut") cut++;
    if (item.state === "signal" || item.state === "cut") review++;
    for (const r of item.effective) removedSeconds += r.end - r.start;
  }
  const groups = [...groupsByToken.values()];
  return { groups, occurrences, totals: { found: groups.reduce((n, g) => n + g.items.length, 0), cut, review, removedSeconds, excess: notes.excess ?? 0 }, pending: notes.pending ?? false };
}
export type AssemblyFillerReport = ReturnType<typeof reportFrom>;

/** Notas e snaps decoram o catálogo já classificado, sem repetir palavras × takes. */
export function decorateFillerReport(project: Project, report: AssemblyFillerReport, notes: FillerReportNotes, index = createFillerIndex(project)) {
  const snapPrefixes = new Set(Object.keys(notes.snaps ?? {}).map(key => key.slice(0, key.lastIndexOf(":")).replace(/:[^:]*$/, "")));
  const noteById = new Map((notes.notes ?? []).map(n => [n.candidateId, n]));
  const occurrences = report.occurrences.map(item => {
    const next = { ...item };
    if (notes.model) {
      const note = noteById.get(item.candidate.id);
      const matched = note && matchingFillerNote(note, item, notes.model);
      if (matched) next.note = matched;
    }
    if (item.state !== "signal" && item.state !== "kept" && item.state !== "abstain") return next;
    const snap = notes.snaps?.[fillerSnapKey(item)];
    const prefix = `${item.candidate.wordIds[0]}:${item.sceneId}:${item.takeId}`;
    const old = !snap && FILLER_CATEGORIES.some(category => snapPrefixes.has(`${category}:${prefix}`));
    const take = index.takes.get(fillerTakeKey(item.sceneId, item.takeId))!.take;
    if (old || (snap && snap.signature !== fillerSignature(project, take, index))) {
      next.state = "abstain"; next.reason = "palavras mudaram; reabra os cacoetes";
    } else if (snap && "abstain" in snap) { next.state = "abstain"; next.reason = snap.reason; }
    return next;
  });
  return reportFrom(occurrences, notes);
}

export function fillerReport(project: Project, notes: FillerReportNotes = {}, scope: Scope = {}) {
  const index = scope.index ?? createFillerIndex(project), occurrences: FillerOccurrence[] = [];
  const wanted = scope.targets && new Set(scope.targets.map(t => fillerTakeKey(t.sceneId, t.takeId)));
  const sceneIds = scope.sceneIds && new Set(scope.sceneIds);
  const exceptions = new Set((project.fillerExceptions ?? []).map(e => JSON.stringify([e.wordId, e.text])));
  for (const [takeKey, entry] of index.takes) {
    const { sceneId, sceneNumber, take } = entry;
    if ((wanted && !wanted.has(takeKey)) || (sceneIds && !sceneIds.has(sceneId))) continue;
    const source = index.source(take.sourceId), words = source.words;
    const currentCuts = (take.fillers?.cuts ?? []).filter(c => fillerCutIsCurrent(project, take, c, index));
    const represented = new Set<FillerCut>();
    for (const candidate of classifyFillers(index.tokens(take), FILLER_AUTO_CATEGORIES.montagem, FILLER_MIN_GAP_SECONDS.montagem)) {
      const selected = candidate.wordIds.map(id => source.byId.get(id)!).filter(Boolean);
      const firstIndex = source.positions.get(selected[0]?.id ?? "") ?? -1;
      const lastIndex = source.positions.get(selected.at(-1)?.id ?? "") ?? -1;
      const unitIndex = source.unitPositions[firstIndex] ?? -1;
      const item: FillerObserveItem = { candidate, unitText: source.unitText[unitIndex] ?? "", prevText: source.unitText[unitIndex - 1] ?? "", nextText: source.unitText[unitIndex + 1] ?? "" };
      const layer = currentCuts.find(c => c.category === candidate.category && c.wordIds.join("\0") === candidate.wordIds.join("\0") && c.wordTexts.every((t, i) => t === selected[i]?.text));
      if (layer) represented.add(layer);
      const kept = selected.some(w => exceptions.has(JSON.stringify([w.id, w.text])));
      let state: FillerOccurrence["state"] = layer ? "cut" : candidate.verdict === "abstain" ? "abstain" : kept ? "kept" : "signal";
      let reason = candidate.abstainReason;
      if (!layer && selected.some(w => overlaps(w, take.removed))) { state = "absorbed"; reason = "removido por outra edição"; }
      if (!layer && overlaps(candidate, take.protected)) { state = "abstain"; reason = "trecho protegido"; }
      occurrences.push({ candidateId: candidate.id, sceneId, takeId: take.id, ...item, sourceId: take.sourceId, sceneNumber, state,
        wordTexts: selected.map(w => w.text), ...(layer ? { origin: layer.origin } : {}), ...(reason ? { reason } : {}), effective: layer?.effective ?? [],
        listen: { start: words[firstIndex - 1]?.start ?? candidate.start, end: words[lastIndex + 1]?.end ?? candidate.end } });
    }
    // Uma transcrição nova nunca esconde mídia que já foi removida pela camada.
    for (const cut of take.fillers?.cuts ?? []) {
      if (represented.has(cut)) continue;
      const previousGeneration = !currentCuts.includes(cut);
      const start = Math.min(...cut.effective.map(r => r.start)), end = Math.max(...cut.effective.map(r => r.end));
      const candidate: FillerCandidate = { id: `${cut.category}:${cut.wordIds[0]}`, category: cut.category,
        token: normalizeFillerText(cut.wordTexts[0]!), wordIds: cut.wordIds, start, end, rule: cut.rule, verdict: "signal" };
      occurrences.push({ candidateId: candidate.id, sceneId, takeId: take.id, sourceId: take.sourceId, sceneNumber,
        candidate, unitText: cut.wordTexts.join(" "), prevText: "", nextText: "", state: "cut", origin: cut.origin,
        previousGeneration, wordTexts: cut.wordTexts, effective: cut.effective,
        ...(previousGeneration ? { reason: "corte de cacoete de uma transcrição anterior" } : {}), listen: { start, end } });
    }
  }
  const report = reportFrom(occurrences, {});
  return Object.keys(notes).length ? decorateFillerReport(project, report, notes, index) : report;
}

/** O relatório da resposta também serve para podar o cache acústico. */
export function currentFillerSnaps(project: Project, snaps: FillerSnaps, report?: AssemblyFillerReport, index = createFillerIndex(project)): FillerSnaps {
  if (!Object.keys(snaps).length) return {};
  const current: FillerSnaps = {};
  for (const item of (report ?? fillerReport(project, {}, { index })).occurrences) {
    const key = fillerSnapKey(item), snap = snaps[key];
    const take = index.takes.get(fillerTakeKey(item.sceneId, item.takeId))!.take;
    if (snap && !snap.transient && snap.signature === fillerSignature(project, take, index) && (!snap.selection || snap.selection === fillerSelectionSignature(project, take))) current[key] = snap;
  }
  return current;
}

export function autoFillerTargets(project: Project, sceneIds?: string[]): FillerTarget[] {
  return fillerReport(project, {}, { sceneIds }).occurrences.filter(o => o.state === "signal" && o.candidate.verdict === "cut").map(({ candidateId, sceneId, takeId }) => ({ candidateId, sceneId, takeId }));
}

export function fillerCutResult(project: Project, take: SpeechTake, candidate: FillerCandidate, range: SourceRange, index = createFillerIndex(project)): { removed: SourceRange[]; effective: SourceRange[] } | string {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start >= range.end || range.start < take.start || range.end > take.end) return "intervalo acústico inválido";
  if (range.start > candidate.start || range.end < candidate.end) return "corte não cobre a palavra inteira";
  if (overlaps(range, take.protected)) return "trecho protegido";
  const words = index.source(take.sourceId).words;
  const removed = mergeRemoved(take, [range], words, project.assembly.fps), effective = subtractRanges(removed, take.removed);
  const ids = new Set(candidate.wordIds);
  const maintained = words.filter(w => !ids.has(w.id) && subtractRanges([w], take.removed).length > 0);
  if (effective.some(r => overlaps(r, maintained))) return "corte levaria palavra mantida";
  const minimum = project.assembly.fps.den / project.assembly.fps.num;
  if (retainedRanges({ ...take, removed }).some(r => r.end - r.start < minimum - 1e-9)) return "fragmento menor que um quadro";
  return { removed, effective };
}

function replaceTake(project: Project, sceneId: string, take: SpeechTake): Project {
  return { ...project, scenes: project.scenes.map(s => s.id !== sceneId ? s : { ...s, takes: s.takes.map(t => t.id !== take.id ? t : take) }) };
}

/** Revalida a seleção atual sem reclassificar o projeto a cada alvo do lote. */
export function cutFillerOccurrence(project: Project, item: FillerOccurrence, snap: FillerSnaps[string] | undefined, origin: "auto" | "user", index: FillerIndex): Project {
  if ((item.state !== "signal" && !(origin === "user" && item.state === "kept")) || (origin === "auto" && !FILLER_AUTO_CATEGORIES.montagem.has(item.candidate.category))) return project;
  const take = project.scenes.find(s => s.id === item.sceneId)?.takes.find(t => t.id === item.takeId);
  if (!take || !snap || !("range" in snap) || snap.signature !== fillerSignature(project, take, index)) return project;
  const words = index.source(take.sourceId).byId;
  if (item.candidate.wordIds.some(id => { const w = words.get(id); return !w || overlaps(w, take.removed); })) return project;
  const result = fillerCutResult(project, take, item.candidate, snap.range, index);
  if (typeof result === "string" || !result.effective.length) return project;
  const cut: FillerCut = { generation: fillerGeneration(project, take.sourceId, item.candidate.wordIds, index), wordIds: item.candidate.wordIds, wordTexts: item.wordTexts,
    category: item.candidate.category, rule: item.candidate.rule, origin, effective: result.effective };
  const ids = new Set(item.candidate.wordIds);
  const next = origin === "user" ? { ...project, fillerExceptions: (project.fillerExceptions ?? []).filter(e => !ids.has(e.wordId) || words.get(e.wordId)?.text !== e.text) } : project;
  return replaceTake(next, item.sceneId, { ...take, removed: result.removed, fillers: { cuts: [...(take.fillers?.cuts ?? []), cut] } });
}

/** Camada editorial pura; revisão e compilação pertencem ao chamador. */
export function withFillerCuts(project: Project, targets: FillerTarget[], snaps: FillerSnaps, origin: "auto" | "user"): Project {
  if (!targets.length) return project;
  const index = createFillerIndex(project), report = fillerReport(project, {}, { targets, index });
  const occurrences = new Map(report.occurrences.map(o => [fillerTargetKey(o), o]));
  let next = project;
  for (const target of targets) {
    const item = occurrences.get(fillerTargetKey(target));
    if (item) next = cutFillerOccurrence(next, item, snaps[fillerSnapKey(item)], origin, index);
  }
  return next;
}

export function withoutFillerCuts(project: Project, targets: FillerTarget[]): Project {
  const index = createFillerIndex(project);
  let next = project;
  for (const target of targets) {
    const take = next.scenes.find(s => s.id === target.sceneId)?.takes.find(t => t.id === target.takeId);
    if (!take) continue;
    const cut = take.fillers?.cuts.find(c => `${c.category}:${c.wordIds[0]}` === target.candidateId);
    if (!cut) continue;
    const current = fillerCutIsCurrent(next, take, cut, index);
    const exceptions = new Map((next.fillerExceptions ?? []).map(e => [e.wordId, e]));
    if (current) cut.wordIds.forEach((wordId, i) => exceptions.set(wordId, { wordId, text: cut.wordTexts[i]! }));
    next = replaceTake({ ...next, fillerExceptions: [...exceptions.values()] }, target.sceneId, { ...take,
      removed: subtractRanges(take.removed, cut.effective), fillers: { cuts: take.fillers!.cuts.filter(c => c !== cut) } });
  }
  return next;
}
