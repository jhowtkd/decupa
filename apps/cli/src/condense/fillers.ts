import {
  classifyFillers, FILLER_AUTO_CATEGORIES, FILLER_MIN_GAP_SECONDS, isFillerAligned,
  normalizeFillerText, opensWithFillerAnswer, parseSpeechIndex,
  type FillerCandidate, type FillerObserveItem, type FillerToken, type SpeechIndex,
} from "@decupa/triage";
import type { CondenseTranscript, CondenseWord } from "./prepare.ts";

export type CleanupCandidate = FillerCandidate & { unitId: string; texts: string[] };
export type FillerDecision = { candidateId: string; wordIds: string[]; texts: string[] };
export type FillerDecisions = { cut: FillerDecision[]; kept: FillerDecision[] };
export type FillerCatalog = { transcriptSha256: string; candidates: CleanupCandidate[]; warnings: string[]; legacyReason?: string; index?: SpeechIndex };
export type FillerSpan = { start: number; end: number; unit: string; phrase: string; rule: string; category: string; candidate_id: string; word_ids: string[] };
export const emptyDecisions = (): FillerDecisions => ({ cut: [], kept: [] });
const divergentWarning = (count: number): string => `${count} unidade${count === 1 ? "" : "s"}: transcrição e índice divergem`;

/** A contagem não basta: um cache de outra transcrição pode ter o mesmo tamanho. */
export function cleanupFillers(rawIndex: unknown, transcript: CondenseTranscript | null, transcriptSha256: string): FillerCatalog {
  const catalog: FillerCatalog = { transcriptSha256, candidates: [], warnings: [] };
  const units = (rawIndex as { units?: unknown[] }).units;
  // Índices legados sem palavras ainda podem ser revisados e planejados pelo motor antigo.
  if (!transcript || !units?.some(u => ((u as { words?: unknown[] }).words?.length ?? 0) > 0)) {
    catalog.legacyReason = "índice ou transcrição sem palavras; cacoetes por palavra indisponíveis";
    catalog.warnings.push(catalog.legacyReason);
    return catalog;
  }
  const index = parseSpeechIndex(rawIndex);
  catalog.index = index;
  const words = transcript.segments.flatMap(s => s.words);
  if (words.some(w => !Object.hasOwn(w, "confidence"))) {
    catalog.legacyReason = "transcrição antiga: para cortar cacoetes por palavra, refaça a transcrição";
    catalog.warnings.push(catalog.legacyReason);
  }
  if (index.units.some(u => !u.words?.length)) catalog.warnings.push("unidades sem palavras foram ignoradas nos cacoetes");
  const tokens: FillerToken[] = [];
  let offset = 0, divergent = 0;
  const texts = new Map<string, string>();
  for (let ui = 0; ui < index.units.length; ui++) {
    const unit = index.units[ui]!, indexed = unit.words ?? [];
    if (!indexed.length) continue;
    const joined = words.slice(offset, offset + indexed.length);
    offset += indexed.length;
    const diverged = joined.length !== indexed.length
      || indexed.some((w, i) => normalizeFillerText(w.text) !== normalizeFillerText(joined[i]!.text))
      || (index.transcriptSha256 != null && index.transcriptSha256 !== transcriptSha256);
    if (diverged) {
      catalog.candidates.push({ id: `divergent:${transcriptSha256}:${unit.id}`, unitId: unit.id,
        category: "unit_only_filler", token: unit.text, texts: indexed.map(w => w.text),
        wordIds: indexed.map((_, i) => `${transcriptSha256}:${unit.id}:${i}`), start: unit.start, end: unit.end,
        rule: "junção da transcrição ao índice", verdict: "abstain", abstainReason: "transcrição e índice divergem" });
      divergent++;
      continue;
    }
    let cursor = 0;
    indexed.forEach((w, i) => {
      const source: CondenseWord = joined[i]!;
      const wordId = source.id || `${transcriptSha256}:${unit.id}:${i}`;
      texts.set(wordId, source.text);
      const pos = unit.text.indexOf(w.text, cursor);
      // Separador desconhecido conserva pontuação; jamais inventa uma repetição lexical.
      const separatorBefore = pos < 0 ? "?" : unit.text.slice(cursor, pos);
      if (pos >= 0) cursor = pos + w.text.length;
      tokens.push({ wordId, text: w.text, start: w.start, end: w.end, aligned: isFillerAligned(source.confidence),
        unitId: unit.id, unitEndsWithQuestion: unit.isQuestion, isLastInUnit: i === indexed.length - 1,
        unitWordCount: indexed.length, nextUnitOpensWithAnswer: opensWithFillerAnswer(index.units[ui + 1]?.text ?? ""),
        separatorBefore, prevEnd: indexed[i - 1]?.end ?? index.units[ui - 1]?.words?.at(-1)?.end ?? null,
        nextStart: indexed[i + 1]?.start ?? index.units[ui + 1]?.words?.[0]?.start ?? null });
    });
  }
  if (offset !== words.length) {
    // Uma sobra desloca a associação inteira, portanto nenhuma unidade fica autorizada.
    return { ...catalog, candidates: index.units.filter(unit => unit.words?.length).map(unit => ({ id: `divergent:${transcriptSha256}:${unit.id}`,
      unitId: unit.id, category: "unit_only_filler", token: unit.text, texts: [], wordIds: [], start: unit.start,
      end: unit.end, rule: "junção da transcrição ao índice", verdict: "abstain", abstainReason: "transcrição e índice divergem" })),
    warnings: [...catalog.warnings, divergentWarning(index.units.filter(unit => unit.words?.length).length)] };
  }
  if (divergent) catalog.warnings.push(divergentWarning(divergent));
  const byId = new Map(tokens.map(t => [t.wordId, t]));
  const positions = new Map(tokens.map((t, i) => [t.wordId, i]));
  const raw = classifyFillers(tokens, FILLER_AUTO_CATEGORIES.limpeza, 0);
  const groups: FillerCandidate[][] = [];
  for (const c of raw) {
    const group = groups.at(-1), prev = group?.at(-1);
    if (prev && prev.category === c.category && byId.get(prev.wordIds[0]!)?.unitId === byId.get(c.wordIds[0]!)?.unitId
      && Math.abs(prev.end - c.start) < 1e-9 && positions.get(c.wordIds[0]!)
        === positions.get(prev.wordIds.at(-1)!)! + 1) group!.push(c);
    else groups.push([c]);
  }
  // Candidatos colados são uma remoção só; testar a fronteira interna os faria abster por engano.
  for (const group of groups) for (let i = 1; i < group.length; i++) {
    byId.get(group[i - 1]!.wordIds.at(-1)!)!.nextStart = null;
    byId.get(group[i]!.wordIds[0]!)!.prevEnd = null;
  }
  const checked = new Map(classifyFillers(tokens, FILLER_AUTO_CATEGORIES.limpeza, FILLER_MIN_GAP_SECONDS.limpeza).map(c => [c.id, c]));
  for (const group of groups) {
    const first = checked.get(group[0]!.id)!, last = checked.get(group.at(-1)!.id)!;
    const reason = group.map(c => checked.get(c.id)!.abstainReason).find(Boolean);
    const wordIds = group.flatMap(c => c.wordIds);
    catalog.candidates.push({ ...first, end: last.end, wordIds, texts: wordIds.map(id => texts.get(id)!),
      unitId: byId.get(wordIds[0]!)!.unitId, verdict: reason ? "abstain" : first.verdict,
      ...(reason ? { abstainReason: reason } : {}), ...(group.length > 1 ? { rule: `${first.rule}; candidatos colados fundidos` } : {}) });
  }
  for (const c of catalog.candidates) {
    const unit = index.units.find(u => u.id === c.unitId)!;
    // O motor usa sobreposição aberta; um corte precisa caber inteiro na unidade.
    if (c.start < unit.start || c.end > unit.end) { c.verdict = "abstain"; c.abstainReason = "fora da unidade"; }
  }
  catalog.candidates.sort((a, b) => a.start - b.start);
  return catalog;
}

export function validateSavedFillers(raw: unknown, catalog: FillerCatalog): { decisions: FillerDecisions; warnings: string[] } {
  const result = { decisions: emptyDecisions(), warnings: [] as string[] };
  if (raw == null) return result;
  const saved = raw as { transcriptSha256?: string; cut?: unknown; kept?: unknown };
  if (saved.transcriptSha256 !== catalog.transcriptSha256) {
    const count = [saved.cut, saved.kept].reduce<number>((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    result.warnings.push(`${count} ${count === 1 ? "decisão de cacoete descartada" : "decisões de cacoetes descartadas"}: a transcrição mudou`); return result;
  }
  let discarded = 0;
  for (const kind of ["cut", "kept"] as const) {
    if (!Array.isArray(saved[kind])) {
      if (!result.warnings.length) result.warnings.push("decisões de cacoetes inválidas descartadas");
      continue;
    }
    for (const rawDecision of saved[kind]) {
      const d = rawDecision as FillerDecision;
      const c = catalog.candidates.find(c => c.id === d?.candidateId && c.verdict !== "abstain");
      if (!c || JSON.stringify(c.wordIds) !== JSON.stringify(d.wordIds) || JSON.stringify(c.texts) !== JSON.stringify(d.texts)) {
        discarded++; continue;
      }
      result.decisions[kind].push({ candidateId: c.id, wordIds: [...c.wordIds], texts: [...c.texts] });
    }
  }
  if (discarded) result.warnings.push(`${discarded} ${discarded === 1 ? "decisão de cacoete descartada" : "decisões de cacoetes descartadas"}: palavras ou texto divergentes`);
  // Um arquivo conflitante não pode converter preservação em corte automático.
  result.decisions.cut = result.decisions.cut.filter(d => !result.decisions.kept.some(k => k.candidateId === d.candidateId));
  return result;
}

export function fillerPatch(raw: unknown, catalog: FillerCatalog): Partial<FillerDecisions> {
  if (!raw || typeof raw !== "object") throw Error("decisões de cacoetes inválidas");
  const patch: Partial<FillerDecisions> = {};
  for (const kind of ["cut", "kept"] as const) {
    const list = (raw as Record<string, unknown>)[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw Error(`${kind} precisa ser uma lista`);
    patch[kind] = list.map(d => {
      const decision = d as FillerDecision;
      const c = catalog.candidates.find(c => c.id === decision?.candidateId && c.verdict !== "abstain");
      if (!c || JSON.stringify(c.wordIds) !== JSON.stringify(decision.wordIds)) throw Error("cacoete ou wordIds não correspondem ao índice");
      return { candidateId: c.id, wordIds: [...c.wordIds], texts: [...c.texts] };
    });
  }
  if (!patch.cut && !patch.kept) throw Error("informe cut ou kept");
  if (patch.cut?.some(d => patch.kept?.some(k => k.candidateId === d.candidateId))) throw Error("mesmo cacoete em cut e kept");
  return patch;
}

export function mergeFillerDecisions(current: FillerDecisions, patch: Partial<FillerDecisions>): FillerDecisions {
  const next = structuredClone(current);
  for (const kind of ["cut", "kept"] as const) for (const d of patch[kind] ?? []) {
    next.cut = next.cut.filter(old => old.candidateId !== d.candidateId);
    next.kept = next.kept.filter(old => old.candidateId !== d.candidateId);
    next[kind].push(d);
  }
  return next;
}

export function selectedFillers(catalog: FillerCatalog, decisions: FillerDecisions, unitIds: ReadonlySet<string>): FillerSpan[] {
  return catalog.candidates.filter(c => c.verdict !== "abstain" && unitIds.has(c.unitId)
    && !decisions.kept.some(d => d.candidateId === c.id)
    && (c.verdict === "cut" || decisions.cut.some(d => d.candidateId === c.id))).map(c => ({
    start: c.start, end: c.end, unit: c.unitId, phrase: c.texts.join(" "), rule: c.rule,
    category: c.category, candidate_id: c.id, word_ids: [...c.wordIds],
  }));
}

export function ambiguousItems(catalog: FillerCatalog, unitIds: ReadonlySet<string>, includeAbstained = false): FillerObserveItem[] {
  return catalog.candidates.filter(c => c.category === "ambiguous" && (includeAbstained || c.verdict !== "abstain") && unitIds.has(c.unitId)).map(candidate => {
    const units = catalog.index!.units, i = units.findIndex(u => u.id === candidate.unitId);
    return { candidate, unitText: units[i]!.text, prevText: units[i - 1]?.text ?? "", nextText: units[i + 1]?.text ?? "" };
  });
}
