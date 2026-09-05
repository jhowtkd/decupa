/**
 * Passe 0 da triagem: retakes, ar morto e fala com o operador.
 *
 * Puro sobre o speech_index. Sem visual_index, sem LLM.
 */

import { acceptedDropIds, verifyClaims, type StructureClaim } from "./claims.ts";
import { hasDirectorCue } from "./cues.ts";
import { keepListFrom } from "./keeplist.ts";
import { retakeClaims } from "./retakes.ts";
import { topicSpan, type IndexUnit, type SpeechIndex } from "./speech-index.ts";

export function mechanicalClaims(index: SpeechIndex): StructureClaim[] {
  const claims: StructureClaim[] = [...retakeClaims(index)];
  const claimed = new Set<string>();
  for (const c of claims) for (const id of c.unit_ids) claimed.add(id);

  const preroll = leadingPreroll(index, claimed);
  if (preroll) {
    claims.push(preroll);
    for (const id of preroll.unit_ids) claimed.add(id);
  }

  const postroll = trailingPostroll(index, claimed);
  if (postroll) {
    claims.push(postroll);
    for (const id of postroll.unit_ids) claimed.add(id);
  }

  for (const dead of deadAirClaims(index, claimed)) {
    claims.push(dead);
    for (const id of dead.unit_ids) claimed.add(id);
  }

  for (const cue of midCueClaims(index, claimed)) {
    claims.push(cue);
    for (const id of cue.unit_ids) claimed.add(id);
  }

  return claims;
}

export function mechanicalKeepList(index: SpeechIndex): string {
  const verdicts = verifyClaims(mechanicalClaims(index), index);
  return keepListFrom(index, acceptedDropIds(verdicts));
}

function deadAirClaims(index: SpeechIndex, claimed: Set<string>): StructureClaim[] {
  const out: StructureClaim[] = [];
  for (const t of index.trimCandidates) {
    if (claimed.has(t.id)) continue;
    if (!looksLikeDeadAir(t.reasons)) continue;
    out.push({
      unit_ids: [t.id],
      reason: "dead_air",
      restated_by: null,
      note: "ar morto / quase sem conteúdo",
      source: "mechanical",
    });
  }
  return out;
}

function leadingPreroll(index: SpeechIndex, claimed: Set<string>): StructureClaim | null {
  const prefix: IndexUnit[] = [];
  for (const unit of index.units) {
    if (!isCueOrFiller(unit, index)) break;
    prefix.push(unit);
  }
  if (prefix.length === 0) return null;
  if (prefix[0]!.index !== index.units[0]!.index) return null;
  const span = topicSpan(index);
  if (span && prefix[prefix.length - 1]!.index >= span.first) return null;
  const ids = prefix.map((u) => u.id).filter((id) => !claimed.has(id));
  if (ids.length === 0) return null;
  return {
    unit_ids: ids,
    reason: "preroll",
    restated_by: null,
    note: "fala com o operador antes do vídeo começar",
    source: "mechanical",
  };
}

function trailingPostroll(index: SpeechIndex, claimed: Set<string>): StructureClaim | null {
  const suffix: IndexUnit[] = [];
  for (let i = index.units.length - 1; i >= 0; i -= 1) {
    const unit = index.units[i]!;
    if (!isCueOrFiller(unit, index)) break;
    suffix.unshift(unit);
  }
  if (suffix.length === 0) return null;
  if (suffix[suffix.length - 1]!.index !== index.units[index.units.length - 1]!.index) return null;
  const span = topicSpan(index);
  if (span && suffix[0]!.index <= span.last) return null;
  const ids = suffix.map((u) => u.id).filter((id) => !claimed.has(id));
  if (ids.length === 0) return null;
  return {
    unit_ids: ids,
    reason: "postroll",
    restated_by: null,
    note: "fala com o operador depois do vídeo acabar",
    source: "mechanical",
  };
}

function midCueClaims(index: SpeechIndex, claimed: Set<string>): StructureClaim[] {
  const out: StructureClaim[] = [];
  for (const unit of index.units) {
    if (claimed.has(unit.id)) continue;
    if (!hasDirectorCue(unit.text)) continue;
    out.push({
      unit_ids: [unit.id],
      reason: "director_cue",
      restated_by: null,
      note: "fala com o operador no meio do vídeo",
      source: "mechanical",
    });
  }
  return out;
}

function isCueOrFiller(unit: IndexUnit, index: SpeechIndex): boolean {
  if (hasDirectorCue(unit.text)) return true;
  if (unit.duration < 0.5 && unit.wordCount <= 2) return true;
  const trim = index.trimCandidates.find((t) => t.id === unit.id);
  if (!trim) return false;
  return trim.reasons.some((r) => {
    const t = r.toLowerCase();
    return t.includes("filler") || t.includes("hesitation");
  });
}

function looksLikeDeadAir(reasons: string[]): boolean {
  return reasons.some((r) => {
    const t = r.toLowerCase();
    return t.includes("dead air")
      || t.includes("almost no content")
      || t.includes("no content")
      || t.includes("chars/s")
      || t.includes("very slow");
  });
}
