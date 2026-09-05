/**
 * Agrupa retakes e escolhe o take que fica.
 *
 * Um par entra no grupo se isRestatement, nearDuplicateOf do motor, ou o bloco
 * seguinte (frase partida) é retomada por SequenceMatcher. headOverlap sozinho
 * não dropa — u009/u010 o ouro mantém os dois.
 *
 * Penalidade pesada: ar morto em trim_candidates. Empate (ou quase) → o take
 * de depois ganha. Se o take de depois tem ar morto, fica o anterior (u020).
 */

import type { StructureClaim } from "./claims.ts";
import {
  MOTOR_DUPLICATE_THRESHOLD,
  characterSimilarity,
  isRestatement,
} from "./similarity.ts";
import type { IndexUnit, SpeechIndex } from "./speech-index.ts";

/** Contíguo ou a até 2 unidades de distância → diferença de index no máximo 3. */
const MAX_INDEX_GAP = 3;
const DEAD_AIR_PENALTY = 100;
const SHORT_DURATION_PENALTY = 10;
const NO_PUNCT_PENALTY = 1;
/** Abaixo disto a diferença de score é empate e o take de depois ganha. */
const TIE_MARGIN = 5;
const SHORT_DURATION = 0.6;
const MAX_FOLLOWING_BLOCK = 4;

export function retakeClaims(index: SpeechIndex): StructureClaim[] {
  const units = index.units;
  if (units.length < 2) return [];

  const parent = new Map<string, string>();
  for (const u of units) parent.set(u.id, u.id);

  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p !== id) {
      const root = find(p);
      parent.set(id, root);
      return root;
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  };

  for (let i = 0; i < units.length; i += 1) {
    const a = units[i]!;
    for (let j = i + 1; j < units.length; j += 1) {
      const b = units[j]!;
      if (b.index - a.index > MAX_INDEX_GAP) break;
      if (pairRelated(a, b)) union(a.id, b.id);
    }
  }

  for (let i = 0; i < units.length; i += 1) {
    const origin = units[i]!;
    const block = followingRestatement(units, i);
    for (const u of block) union(origin.id, u.id);
  }

  const buckets = new Map<string, IndexUnit[]>();
  for (const u of units) {
    const root = find(u.id);
    const siblings = buckets.get(root);
    if (siblings) siblings.push(u);
    else buckets.set(root, [u]);
  }

  const claims: StructureClaim[] = [];
  const already = new Set<string>();

  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.index - b.index);
    if (members.some((u) => already.has(u.id))) continue;

    const coreIds = new Set(members.map((u) => u.id));
    const lo = members[0]!.index;
    const hi = members[members.length - 1]!.index;
    const span = units.filter((u) => u.index >= lo && u.index <= hi);
    const takes = splitTakes(span, coreIds);
    if (takes.length < 2) continue;

    const restart = restartCompletion(index, takes);
    if (restart) {
      const drop = units.filter((u) => u.index >= lo && u.index < restart.index);
      if (drop.length === 0) continue;
      for (const u of drop) already.add(u.id);
      claims.push({
        unit_ids: drop.map((u) => u.id),
        reason: "restart_block",
        restated_by: restart.id,
        note: `bloco de recomeço; fica ${restart.id}`,
        source: "mechanical",
      });
      continue;
    }

    const winner = chooseTake(takes, index);
    const dropped = takes.filter((t) => t !== winner).flat();
    if (dropped.length === 0) continue;
    const kept = winner[winner.length - 1]!;
    for (const u of dropped) already.add(u.id);
    claims.push({
      unit_ids: dropped.map((u) => u.id),
      reason: "retake",
      restated_by: kept.id,
      note: `retomada da mesma frase; fica ${kept.id}`,
      source: "mechanical",
    });
  }

  return claims;
}

function pairRelated(a: IndexUnit, b: IndexUnit): boolean {
  const motor = pairMotor(a, b);
  if (a.nearDuplicateOf === b.id || b.nearDuplicateOf === a.id) return true;
  if (isRestatement(a.text, b.text, motor)) return true;
  return false;
}

function pairMotor(a: IndexUnit, b: IndexUnit): number | null {
  if (a.nearDuplicateOf === b.id && a.similarity != null) return a.similarity;
  if (b.nearDuplicateOf === a.id && b.similarity != null) return b.similarity;
  return null;
}

/**
 * Prefixo contíguo seguinte que ainda é retomada de `origin`.
 *
 * Para no último prefixo que casa — senão u016 (sem ponto) arrasta u017
 * ("de comunicação com sua instituição") para o grupo de u015.
 */
function followingRestatement(units: IndexUnit[], originPos: number): IndexUnit[] {
  const origin = units[originPos]!;
  const acc: IndexUnit[] = [];
  let best: IndexUnit[] = [];
  for (let j = originPos + 1; j < units.length && acc.length < MAX_FOLLOWING_BLOCK; j += 1) {
    const u = units[j]!;
    const prevIndex = acc.length === 0 ? origin.index : acc[acc.length - 1]!.index;
    if (u.index !== prevIndex + 1) break;
    acc.push(u);
    const concat = acc.map((x) => x.text).join(" ");
    // Score do motor só vale para o par unitário; no bloco concatenado medimos de novo.
    const motor = acc.length === 1 ? pairMotor(origin, acc[0]!) : null;
    if (
      isRestatement(origin.text, concat, motor)
      || characterSimilarity(origin.text, concat) >= MOTOR_DUPLICATE_THRESHOLD
    ) {
      best = acc.slice();
    }
    if (u.hasTerminalPunct) break;
  }
  return best;
}

function splitTakes(span: IndexUnit[], coreIds: Set<string>): IndexUnit[][] {
  const takes: IndexUnit[][] = [];
  let current: IndexUnit[] = [];
  for (const unit of span) {
    if (current.length === 0) {
      current = [unit];
      continue;
    }
    const currentDone = current.some((u) => u.hasTerminalPunct);
    const restatesStart = coreIds.has(unit.id) && pairRelated(current[0]!, unit);
    if (coreIds.has(unit.id) && (currentDone || restatesStart)) {
      takes.push(current);
      current = [unit];
    } else {
      current.push(unit);
    }
  }
  if (current.length > 0) takes.push(current);
  return takes;
}

function takeScore(take: IndexUnit[], deadAir: Set<string>): number {
  let score = 0;
  if (take.some((u) => deadAir.has(u.id))) score -= DEAD_AIR_PENALTY;
  if (take.some((u) => u.duration < SHORT_DURATION)) score -= SHORT_DURATION_PENALTY;
  if (!take.some((u) => u.hasTerminalPunct)) score -= NO_PUNCT_PENALTY;
  return score;
}

function chooseTake(takes: IndexUnit[][], index: SpeechIndex): IndexUnit[] {
  const deadAir = deadAirIds(index);
  let best = takes[0]!;
  for (const take of takes.slice(1)) {
    const delta = takeScore(take, deadAir) - takeScore(best, deadAir);
    // Take de depois ganha no empate e quando a diferença é só pontuação/duração leve.
    if (delta >= -TIE_MARGIN) best = take;
  }
  return best;
}

function deadAirIds(index: SpeechIndex): Set<string> {
  const ids = new Set<string>();
  for (const t of index.trimCandidates) {
    if (looksLikeDeadAir(t.reasons)) ids.add(t.id);
  }
  return ids;
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

/**
 * Três ou mais takes da mesma frase curta: o vencedor interno ainda é um
 * fragmento; a formulação completa vem depois (u032–u036 → u038).
 */
function restartCompletion(index: SpeechIndex, takes: IndexUnit[][]): IndexUnit | null {
  if (takes.length < 3) return null;
  const last = takes[takes.length - 1]![takes[takes.length - 1]!.length - 1]!;
  const stub = shortestTakeText(takes);
  const stubTokens = tokenize(stub);
  if (stubTokens.length === 0) return null;

  for (const unit of index.units) {
    if (unit.index <= last.index) continue;
    if (unit.index - last.index > MAX_INDEX_GAP) break;
    if (!unit.hasTerminalPunct) continue;
    if (tokenize(unit.text).length <= stubTokens.length) continue;
    if (containsStubBigram(stubTokens, tokenize(unit.text))) return unit;
  }
  return null;
}

function shortestTakeText(takes: IndexUnit[][]): string {
  let best = takes[0]!;
  for (const take of takes.slice(1)) {
    const t = take.map((u) => u.text).join(" ");
    const b = best.map((u) => u.text).join(" ");
    if (t.length < b.length) best = take;
  }
  return best.map((u) => u.text).join(" ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function containsStubBigram(stub: string[], later: string[]): boolean {
  if (stub.length === 1) return later.includes(stub[0]!);
  const hay = ` ${later.join(" ")} `;
  for (let i = 0; i < stub.length - 1; i += 1) {
    if (hay.includes(` ${stub[i]} ${stub[i + 1]} `)) return true;
  }
  return false;
}
