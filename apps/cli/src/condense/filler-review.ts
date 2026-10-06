import type { FillerCatalog, FillerDecisions, CleanupCandidate } from "./fillers.ts";

export type FillerProvenance = { candidateId: string; category: string; rule: string };
export type ReviewFiller = CleanupCandidate & { status: "cut" | "kept" | "signal" | "abstain" | "skipped"; reason?: string; removedSeconds: number };
export type ReviewFillers = { groups: { token: string; items: ReviewFiller[] }[]; totalSeconds: number;
  skipped: { candidateId: string; reason: string }[]; warnings: string[]; supported: boolean; count: number };
export type FillerReviewOptions = { generation: number; catalog: FillerCatalog; decisions: FillerDecisions; supported: boolean };
type Interval = { start: number; end: number };
export type MeasuredFiller = FillerProvenance & { removed: Interval[] };
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Error("plano: intervalo de cacoete inválido");
  return value;
}
export function measuredFillers(rawPlan: unknown): MeasuredFiller[] {
  const plan = rawPlan as { removed?: { filler_items?: Record<string, unknown>[] } };
  return (plan.removed?.filler_items ?? []).map(item => ({ candidateId: String(item.candidate_id),
    category: String(item.category), rule: String(item.rule),
    removed: (item.removed as Interval[] ?? []).map(span => {
      const start = finite(span.start), end = finite(span.end);
      if (start < 0 || end < start) throw Error("plano: intervalo de cacoete inválido");
      return { start, end };
    }),
  }));
}
function seconds(spans: Interval[]): number {
  let sum = 0, end = -Infinity;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) { sum += Math.max(0, s.end - Math.max(end, s.start)); end = Math.max(end, s.end); }
  return sum;
}
export function fillerJoin(raw: Record<string, unknown>, measured: MeasuredFiller[]): { isFiller: boolean; fillerItems: FillerProvenance[]; candidateId?: string; category?: string; rule?: string } {
  const out = Number(raw.source_out), inn = Number(raw.source_in);
  const matches = measured.filter(item => item.removed.some(span => span.end > out && span.start < inn));
  const covered = seconds(matches.flatMap(item => item.removed).map(s => ({ start: Math.max(out, s.start), end: Math.min(inn, s.end) })).filter(s => s.end > s.start));
  const items = matches.map(({ candidateId, category, rule }) => ({ candidateId, category, rule }));
  return { isFiller: raw.kind === "filler" || raw.out_reason === "filler" || (inn > out && covered >= inn - out - 1e-6), fillerItems: items, ...items[0] };
}
export function reviewFillers(rawPlan: unknown, opts?: FillerReviewOptions): ReviewFillers {
  const plan = rawPlan as { removed?: { filler_items?: unknown[]; filler_skipped?: Record<string, unknown>[] }; filler_skipped?: Record<string, unknown>[]; joins?: Record<string, unknown>[] };
  const measured = measuredFillers(rawPlan);
  const skipped = (plan.removed?.filler_skipped ?? plan.filler_skipped ?? []).map(item => ({ candidateId: String(item.candidate_id), reason: String(item.reason) }));
  const warnings = [...(opts?.catalog.warnings ?? [])];
  if (opts && !opts.supported && !opts.catalog.legacyReason) warnings.push("motor sem suporte a corte por palavra; atualize o motor");
  const groups = new Map<string, ReviewFiller[]>();
  for (const c of opts?.catalog.candidates ?? []) {
    const removal = measured.filter(m => m.candidateId === c.id).flatMap(m => m.removed);
    const skip = skipped.find(s => s.candidateId === c.id);
    const kept = opts!.decisions.kept.some(d => d.candidateId === c.id);
    const status = c.verdict === "abstain" ? "abstain" : skip ? "skipped" : kept ? "kept"
      : removal.length ? "cut" : "signal";
    const item: ReviewFiller = { ...c, status, removedSeconds: seconds(removal),
      ...(c.abstainReason || skip?.reason ? { reason: c.abstainReason ?? skip?.reason } : {}) };
    const list = groups.get(c.token) ?? []; list.push(item); groups.set(c.token, list);
  }
  const hasMeasured = Array.isArray(plan.removed?.filler_items);
  const legacy = (plan.joins ?? []).filter(j => j.kind === "filler" || j.out_reason === "filler");
  return { groups: [...groups].map(([token, items]) => ({ token, items })), skipped, warnings,
    supported: opts?.supported ?? false,
    totalSeconds: hasMeasured ? seconds(measured.flatMap(m => m.removed)) : legacy.reduce((s, j) => s + Number(j.removed_seconds ?? 0), 0),
    count: hasMeasured ? measured.filter(m => m.removed.some(s => s.end > s.start)).length : legacy.length };
}
