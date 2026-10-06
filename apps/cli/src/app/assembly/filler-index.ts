import { isFillerAligned, normalizeFillerText, opensWithFillerAnswer, type FillerToken } from "@decupa/triage";
import type { Project, SpeechTake, Word } from "./types.ts";
import { effectiveWords } from "./words.ts";

export function fillerTakeKey(sceneId: string, takeId: string): string { return JSON.stringify([sceneId, takeId]); }
export function fillerTargetKey(target: { sceneId: string; takeId: string; candidateId: string }): string {
  return JSON.stringify([target.sceneId, target.takeId, target.candidateId]);
}

function lowerBound<T>(items: T[], before: (item: T) => boolean): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (before(items[mid]!)) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Catálogos preguiçosos: uma fonte é indexada uma vez, mesmo usada em várias cenas. */
export function createFillerIndex(project: Project) {
  const analyses = new Map(project.analyses.map(a => [a.sourceId, a]));
  const sources = new Map(project.assembly.sources.map(s => [s.id, s]));
  const takes = new Map<string, { sceneId: string; sceneNumber: number; take: SpeechTake }>();
  const takesBySource = new Map<string, SpeechTake[]>();
  for (const [i, scene] of project.scenes.entries()) for (const take of scene.takes) {
    takes.set(fillerTakeKey(scene.id, take.id), { sceneId: scene.id, sceneNumber: i + 1, take });
    const entries = takesBySource.get(take.sourceId) ?? []; entries.push(take); takesBySource.set(take.sourceId, entries);
  }
  const catalogs = new Map<string, ReturnType<typeof buildSource>>();
  function buildSource(sourceId: string) {
    const analysis = analyses.get(sourceId), words = effectiveWords(project, sourceId);
    const byId = new Map(words.map(w => [w.id, w])), positions = new Map(words.map((w, i) => [w.id, i]));
    const units = [...(analysis?.speech ?? [])].sort((a, b) => a.start - b.start);
    // Máximos acumulados mantêm a busca correta mesmo com unidades sobrepostas.
    let maxEnd = -Infinity;
    const ends = units.map(u => maxEnd = Math.max(maxEnd, u.end));
    const unitPositions = words.map(w => {
      const i = lowerBound(ends, end => end <= w.start);
      return units[i] && units[i]!.start < w.end ? i : -1;
    });
    const unitWords: Word[][] = units.map(() => []);
    words.forEach((w, i) => { const n = unitPositions[i]!; if (n >= 0) unitWords[n]!.push(w); });
    const separators = new Map<string, string>();
    for (const [i, unit] of units.entries()) {
      let cursor = 0;
      const text = unit.text.normalize("NFC").toLocaleLowerCase("pt-BR");
      for (const word of unitWords[i]!) {
        const needle = normalizeFillerText(word.text), found = text.indexOf(needle, cursor);
        // Uma correção que não casa com a unidade não prova repetição por espaço.
        separators.set(word.id, found < 0 ? "," : text.slice(cursor, found));
        if (found >= 0) cursor = found + needle.length;
      }
    }
    const tokens: FillerToken[] = words.map((word, i) => {
      const n = unitPositions[i]!, unit = units[n], selected = unitWords[n] ?? [], nextUnit = units[n + 1];
      return { wordId: word.id, text: word.text, start: word.start, end: word.end,
        aligned: analysis?.wordsStatus === "ready" && isFillerAligned(word.confidence) && !!unit,
        unitId: unit?.id ?? `missing:${word.id}`, unitEndsWithQuestion: !!unit?.text.trim().endsWith("?"),
        isLastInUnit: selected.at(-1)?.id === word.id, unitWordCount: selected.length,
        nextUnitOpensWithAnswer: !!unit && !!nextUnit && opensWithFillerAnswer(nextUnit.text),
        separatorBefore: separators.get(word.id) ?? ",", prevEnd: words[i - 1]?.end ?? null, nextStart: words[i + 1]?.start ?? null };
    });
    let wordEnd = -Infinity;
    const wordEnds = words.map(w => wordEnd = Math.max(wordEnd, w.end));
    const unitText = units.map(unit => {
      const selected: string[] = [];
      for (let i = lowerBound(wordEnds, end => end <= unit.start); i < words.length && words[i]!.start < unit.end; i++) {
        if (words[i]!.end > unit.start) selected.push(words[i]!.text);
      }
      return selected.join(" ");
    });
    return { words, byId, positions, unitPositions, unitText, tokens };
  }
  const source = (id: string) => { let value = catalogs.get(id); if (!value) { value = buildSource(id); catalogs.set(id, value); } return value; };
  const tokenCache = new Map<SpeechTake, FillerToken[]>(), signatures = new Map<SpeechTake, string>();
  function tokens(take: SpeechTake) {
    let value = tokenCache.get(take);
    if (!value) {
      const all = source(take.sourceId).tokens, start = lowerBound(all, t => t.start < take.start);
      value = [];
      for (let i = start; i < all.length && all[i]!.start < take.end; i++) if (all[i]!.end <= take.end) value.push(all[i]!);
      tokenCache.set(take, value);
    }
    return value;
  }
  return { source, sources, takes, takesBySource, tokens, signatures };
}
export type FillerIndex = ReturnType<typeof createFillerIndex>;
