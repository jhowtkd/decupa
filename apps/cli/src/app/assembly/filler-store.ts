import { FILLER_CATEGORIES } from "@decupa/triage";
import type { FillerCut, Project, SpeechTake } from "./types.ts";
import { effectiveWords, subtractRanges } from "./words.ts";

export function validateFillerCuts(raw: unknown, take: SpeechTake): SpeechTake["fillers"] {
  if (raw === undefined) return undefined;
  const fail = (): never => { throw Error(`take ${take.id}.fillers inválido`); };
  if (!raw || typeof raw !== "object" || !("cuts" in raw) || !Array.isArray(raw.cuts)) fail();
  const seen = new Set<string>();
  return { cuts: (raw as { cuts: unknown[] }).cuts.map(entry => {
    if (!entry || typeof entry !== "object") return fail();
    const cut = entry as FillerCut;
    if (cut.generation !== undefined && (typeof cut.generation !== "string" || !/^[0-9a-f]{64}$/.test(cut.generation))) return fail();
    if (!Array.isArray(cut.wordIds) || !cut.wordIds.length || cut.wordIds.some(id => typeof id !== "string" || !id)
      || new Set(cut.wordIds).size !== cut.wordIds.length || !Array.isArray(cut.wordTexts) || cut.wordTexts.length !== cut.wordIds.length
      || cut.wordTexts.some(t => typeof t !== "string" || !t) || !FILLER_CATEGORIES.includes(cut.category)
      || !["auto", "user"].includes(cut.origin) || typeof cut.rule !== "string" || !cut.rule.trim()
      || !Array.isArray(cut.effective) || !cut.effective.length) return fail();
    if (cut.wordIds.some(id => seen.has(id))) return fail();
    cut.wordIds.forEach(id => seen.add(id));
    const effective = cut.effective.map(r => {
      if (!r || typeof r.start !== "number" || typeof r.end !== "number" || !Number.isFinite(r.start) || !Number.isFinite(r.end)
        || r.start < take.start || r.end > take.end || r.start >= r.end || subtractRanges([r], take.removed).length) return fail();
      return { start: r.start, end: r.end };
    });
    return { ...(cut.generation === undefined ? {} : { generation: cut.generation }), wordIds: [...cut.wordIds], wordTexts: [...cut.wordTexts], category: cut.category, rule: cut.rule, origin: cut.origin, effective };
  }) };
}

/** Exceção obsoleta é dado descartável: não torna um projeto ilegível. */
export function pruneFillerExceptions(project: Project, raw: unknown): NonNullable<Project["fillerExceptions"]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Error("fillerExceptions precisa ser um array");
  const words = new Map(project.assembly.sources.flatMap(s => effectiveWords(project, s.id)).map(w => [w.id, w.text]));
  const entries = new Map<string, { wordId: string; text: string }>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || typeof entry.wordId !== "string" || typeof entry.text !== "string") throw Error("exceção de cacoete inválida");
    if (words.get(entry.wordId) === entry.text) entries.set(entry.wordId, { wordId: entry.wordId, text: entry.text });
  }
  return [...entries.values()];
}
