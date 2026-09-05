/**
 * Passe 0 da triagem: retakes, ar morto e fala com o operador.
 *
 * Puro sobre o speech_index. Sem visual_index, sem LLM.
 */

import { acceptedDropIds, verifyClaims, type StructureClaim } from "./claims.ts";
import { hasDirectorCue } from "./cues.ts";
import { keepListFrom } from "./keeplist.ts";
import { retakeClaims } from "./retakes.ts";
import { looksLikeDeadAir, topicSpan, type IndexUnit, type SpeechIndex } from "./speech-index.ts";

export function mechanicalClaims(index: SpeechIndex): StructureClaim[] {
  const claims: StructureClaim[] = [];
  const occupied = new Set<string>();

  appendVerified(claims, occupied, retakeClaims(index), index);

  const preroll = leadingPreroll(index, occupied);
  if (preroll) appendVerified(claims, occupied, [preroll], index);

  const postroll = trailingPostroll(index, occupied);
  if (postroll) appendVerified(claims, occupied, [postroll], index);

  appendVerified(claims, occupied, deadAirClaims(index, occupied), index);
  appendVerified(claims, occupied, midCueClaims(index, occupied), index);

  return claims;
}

/**
 * Só ocupa unidade de alegação aceita. Rejeitada (retake que não confere, pré-rolo
 * com buraco) deixa o id livre para ar morto / cue na etapa seguinte.
 */
function appendVerified(
  claims: StructureClaim[],
  occupied: Set<string>,
  batch: StructureClaim[],
  index: SpeechIndex,
): void {
  if (batch.length === 0) return;
  for (const v of verifyClaims(batch, index)) {
    claims.push(v.claim);
    if (v.accepted) {
      for (const id of v.claim.unit_ids) occupied.add(id);
    }
  }
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
