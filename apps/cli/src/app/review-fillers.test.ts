import { expect, it } from "vitest";
import { buildReview } from "./review.ts";
import type { FillerCatalog } from "../condense/fillers.ts";

const index = { units: [{ id: "u001", index: 0, start: 0, end: 4, text: "Bom hã dia" }] };
const catalog: FillerCatalog = { transcriptSha256: "sha", warnings: [], candidates: [{ id: "hesitation:w", unitId: "u001", wordIds: ["w"], texts: ["hã"], category: "hesitation", token: "hã", start: 1, end: 1.2, rule: "regra", verdict: "cut" }] };
it("proveniência e segundos vêm de intervalos medidos, inclusive cortes recusados pelo motor", () => {
  const plan = { clips: [{ unit_ids: ["u001"] }], joins: [{ outgoing_unit: "u001", incoming_unit: "u001", source_out: 0.98, source_in: 1.22, removed_seconds: 0.24 }],
    removed: { filler_items: [{ candidate_id: "hesitation:w", category: "hesitation", rule: "regra", removed: [{ start: 0.98, end: 1.22 }] }], filler_skipped: [{ candidate_id: "outro", reason: "content_loss" }] } };
  const review = buildReview(plan, index, undefined, undefined, { generation: 7, catalog, supported: true, decisions: { cut: [], kept: [] } });
  expect(review.generation).toBe(7);
  expect(review.joins[0]).toMatchObject({ isFiller: true, candidateId: "hesitation:w", category: "hesitation", rule: "regra" });
  expect(review.fillers.totalSeconds).toBeCloseTo(0.24); expect(review.fillers.groups[0]!.items[0]).toMatchObject({ status: "cut", removedSeconds: 0.24 });
  expect(review.fillers.skipped).toEqual([{ candidateId: "outro", reason: "content_loss" }]);
  const skipped = buildReview({ ...plan, removed: { filler_items: [], filler_skipped: [{ candidate_id: "hesitation:w", reason: "tight_boundary" }] } }, index, undefined, undefined, { generation: 8, catalog, supported: true, decisions: { cut: [], kept: [] } });
  expect(skipped.fillers.groups[0]!.items[0]).toMatchObject({ status: "skipped", reason: "tight_boundary", removedSeconds: 0 });
});
it("junção legada de cacoete colapsa; lacuna de conteúdo conserva item próprio", () => {
  const review = buildReview({ joins: [{ kind: "filler", removed_seconds: 0.3 }, { kind: "content", removed_seconds: 3 }] }, index);
  expect(review.joins.map(j => j.isFiller)).toEqual([true, false]); expect(review.fillers).toMatchObject({ count: 1, totalSeconds: 0.3 });
});
it("intervalos sobrepostos não duplicam segundos; conteúdo misturado não vira apenas cacoete", () => {
  const review = buildReview({ joins: [{ source_out: 0, source_in: 3 }], removed: { filler_items: [
    { candidate_id: "a", category: "hesitation", rule: "r", removed: [{ start: 1, end: 1.3 }] },
    { candidate_id: "b", category: "hesitation", rule: "r", removed: [{ start: 1.2, end: 1.4 }] },
  ] } }, index);
  expect(review.fillers.totalSeconds).toBeCloseTo(0.4); expect(review.joins[0]!.isFiller).toBe(false);
  expect(review.joins[0]!.fillerItems).toHaveLength(2);
});
it("filler_items explícito vazio informa zero cortes, sem reciclar segundos legados", () => {
  const review = buildReview({ joins: [{ kind: "filler", removed_seconds: 0.3 }], removed: { filler_items: [] } }, index);
  expect(review.fillers).toMatchObject({ count: 0, totalSeconds: 0 });
});
