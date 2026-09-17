import type { Tracer } from "@decupa/trace";
import { mechanicalClaims } from "./mechanical.ts";
import { retakeClaims } from "./retakes.ts";
import { topicSpan, unitsById, type SpeechIndex } from "./speech-index.ts";

export type CandidateKind =
  | "prefix"
  | "suffix"
  | "retake"
  | "negation"
  | "number"
  | "caveat"
  | "protection"
  | "speaker_change"
  | "gap";

export type QuestionGroup = "cut" | "replace" | "protect" | "boundary";

export interface EditCandidate {
  id: string;
  kind: CandidateKind;
  unitIds: string[];
  replacement: string | null;
  protected: boolean;
  questionGroup: QuestionGroup;
}

export interface EditCatalog {
  candidates: EditCandidate[];
  coveredUnitIds: string[];
  uncoveredUnitIds: string[];
  /** Nunca inferido da lista vazia: falta de candidato não é fonte limpa. */
  sourceClean: false;
}

export interface CatalogOptions {
  alreadyDropped?: Iterable<string>;
  tracer?: Tracer;
}

export interface QuestionBatch {
  group: QuestionGroup;
  candidateIds: string[];
}

const KIND_GROUP: Record<CandidateKind, QuestionGroup> = {
  prefix: "cut",
  suffix: "cut",
  gap: "cut",
  retake: "replace",
  negation: "protect",
  number: "protect",
  caveat: "protect",
  protection: "protect",
  speaker_change: "boundary",
};

const GAP_LEAD_SECONDS = 2;
const NEGATION = /\bnão\b|\bnunca\b|\bjamais\b/i;
const NUMBER = /\d/;
const CAVEAT = /\bmas\b|\bporém\b|\bexceto\b|\bsalvo\b|\bcontudo\b|\btodavia\b|\bno entanto\b/i;

export async function buildEditCatalog(
  index: SpeechIndex,
  opts: CatalogOptions = {},
): Promise<EditCatalog> {
  const work = () => build(index, new Set(opts.alreadyDropped ?? []));
  if (opts.tracer) return opts.tracer.run("catalog", work);
  return work();
}

export function groupIndependentQuestions(catalog: EditCatalog): QuestionBatch[] {
  const buckets = new Map<QuestionGroup, string[]>();
  for (const candidate of catalog.candidates) {
    const ids = buckets.get(candidate.questionGroup) ?? [];
    ids.push(candidate.id);
    buckets.set(candidate.questionGroup, ids);
  }
  const order: QuestionGroup[] = ["cut", "replace", "protect", "boundary"];
  return order
    .filter((group) => buckets.has(group))
    .map((group) => ({ group, candidateIds: (buckets.get(group) ?? []).slice().sort() }));
}

function build(index: SpeechIndex, alreadyDropped: Set<string>): EditCatalog {
  const known = unitsById(index);
  const out: EditCandidate[] = [];

  const mechanical = mechanicalClaims(index);

  for (const claim of mechanical) {
    if (claim.reason === "preroll") {
      push(out, known, alreadyDropped, "prefix", claim.unit_ids, null, false);
    } else if (claim.reason === "postroll") {
      push(out, known, alreadyDropped, "suffix", claim.unit_ids, null, false);
    }
  }

  for (const claim of retakeClaims(index)) {
    push(out, known, alreadyDropped, "retake", claim.unit_ids, claim.restated_by, false);
  }

  for (const unit of index.units) {
    if (unit.index > 0 && unit.leadGap >= GAP_LEAD_SECONDS) {
      push(out, known, alreadyDropped, "gap", [unit.id], null, false);
    }
  }

  for (let i = 1; i < index.units.length; i += 1) {
    const prev = index.units[i - 1]!;
    const cur = index.units[i]!;
    if (prev.speaker && cur.speaker && prev.speaker !== cur.speaker) {
      push(out, known, alreadyDropped, "speaker_change", [prev.id, cur.id], null, false);
    }
  }

  for (const unit of index.units) {
    if (NEGATION.test(unit.text)) push(out, known, alreadyDropped, "negation", [unit.id], null, true);
    if (NUMBER.test(unit.text)) push(out, known, alreadyDropped, "number", [unit.id], null, true);
    if (CAVEAT.test(unit.text)) push(out, known, alreadyDropped, "caveat", [unit.id], null, true);
  }

  const span = topicSpan(index);
  const protect = new Set<string>();
  if (span) {
    for (const unit of index.units) {
      if (unit.index === span.first || unit.index === span.last) protect.add(unit.id);
    }
  } else if (index.units.length > 0) {
    protect.add(index.units[0]!.id);
    protect.add(index.units[index.units.length - 1]!.id);
  }
  for (const unit of index.units) {
    if (unit.isQuestion) protect.add(unit.id);
  }
  for (const id of protect) {
    push(out, known, alreadyDropped, "protection", [id], null, true);
  }

  const candidates = unique(out);
  const covered = new Set<string>();
  for (const c of candidates) {
    for (const id of c.unitIds) covered.add(id);
    if (c.replacement) covered.add(c.replacement);
  }
  return {
    candidates,
    coveredUnitIds: index.units.map((u) => u.id).filter((id) => covered.has(id)),
    uncoveredUnitIds: index.units.map((u) => u.id).filter((id) => !covered.has(id)),
    sourceClean: false,
  };
}

function push(
  out: EditCandidate[],
  known: Map<string, { id: string }>,
  alreadyDropped: Set<string>,
  kind: CandidateKind,
  unitIds: string[],
  replacement: string | null,
  protectedUnit: boolean,
): void {
  const ids = unitIds.filter((id) => known.has(id));
  if (ids.length === 0) return;
  if (ids.length !== unitIds.length) return;
  if (replacement) {
    if (!known.has(replacement) || alreadyDropped.has(replacement)) return;
  }
  out.push({
    id: candidateId(kind, ids, replacement),
    kind,
    unitIds: ids,
    replacement,
    protected: protectedUnit,
    questionGroup: KIND_GROUP[kind],
  });
}

function candidateId(kind: CandidateKind, unitIds: string[], replacement: string | null): string {
  const base = `${kind}:${unitIds.join("+")}`;
  return replacement ? `${base}->${replacement}` : base;
}

function unique(candidates: EditCandidate[]): EditCandidate[] {
  const seen = new Set<string>();
  const out: EditCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}
