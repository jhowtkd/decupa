import { describe, expect, it } from "vitest";
import { applyDensityBudget } from "./density.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const index = parseSpeechIndex({
  units: Array.from({ length: 6 }, (_, i) => ({
    id: `u00${i + 1}`, index: i, start: i * 10, end: i * 10 + 5, duration: 5, text: `t${i}`,
  })),
});

const cand = (ids: string[], rank: number) => ({ unit_ids: ids, note: "", rank });

describe("applyDensityBudget", () => {
  it("aplica por rank até fechar o orçamento e para", () => {
    const out = applyDensityBudget([cand(["u001"], 1), cand(["u002"], 2), cand(["u003"], 3)],
      index, { budgetSeconds: 7, alreadyDropped: new Set() });
    // u001 (5s) entra; u002 levaria a 10s, acima de 7 — para antes
    expect([...out.droppedIds]).toEqual(["u001"]);
    expect(out.applied).toHaveLength(1);
  });

  it("respeita o rank mesmo se vier fora de ordem", () => {
    const out = applyDensityBudget([cand(["u003"], 2), cand(["u001"], 1)],
      index, { budgetSeconds: 5, alreadyDropped: new Set() });
    expect([...out.droppedIds]).toEqual(["u001"]);
  });

  it("pula candidato que já saiu no passe 1, sem gastar orçamento", () => {
    const out = applyDensityBudget([cand(["u001"], 1), cand(["u002"], 2)],
      index, { budgetSeconds: 5, alreadyDropped: new Set(["u001"]) });
    expect([...out.droppedIds]).toEqual(["u002"]);
    expect(out.skipped[0]!.why).toMatch(/passe 1/);
  });

  it("pula id inexistente em vez de estourar", () => {
    const out = applyDensityBudget([cand(["u999"], 1), cand(["u002"], 2)],
      index, { budgetSeconds: 5, alreadyDropped: new Set() });
    expect([...out.droppedIds]).toEqual(["u002"]);
    expect(out.skipped[0]!.why).toMatch(/u999/);
  });

  it("não dropa nada com orçamento zero", () => {
    const out = applyDensityBudget([cand(["u001"], 1)], index,
      { budgetSeconds: 0, alreadyDropped: new Set() });
    expect(out.droppedIds.size).toBe(0);
  });

  it("nunca dropa tudo — mantém ao menos uma unidade", () => {
    const all = index.units.map((u, i) => cand([u.id], i + 1));
    const out = applyDensityBudget(all, index, { budgetSeconds: 9999, alreadyDropped: new Set() });
    expect(out.droppedIds.size).toBeLessThan(index.units.length);
  });
});
