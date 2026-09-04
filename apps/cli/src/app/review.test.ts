import { describe, expect, it } from "vitest";
import { buildReview } from "./review.ts";

const index = {
  units: [
    { id: "u001", index: 0, text: "Eu esqueci o começo." },
    { id: "u002", index: 1, text: "Dicas pra você." },
    { id: "u003", index: 2, text: "Primeira coisa." },
  ],
};

const plan = {
  source_duration: 40,
  output_duration: 12,
  clips: [{ unit_ids: ["u002", "u003"], start: 10, end: 22 }],
  joins: [{
    outgoing_unit: "u002",
    incoming_unit: "u003",
    removed_seconds: 3.5,
    outgoing_tail: "pra você.",
    incoming_head: "Primeira coisa",
    flags: [{
      code: "mid_thought_out", severity: "warning",
      message: "u002 não tem pontuação final", hint: "Estenda o clipe.",
    }],
  }],
};

describe("buildReview", () => {
  it("traz todas as unidades, em ordem de fonte", () => {
    expect(buildReview(plan, index).units.map((u) => u.id)).toEqual(["u001", "u002", "u003"]);
  });

  it("marca como kept só as que aparecem em algum clipe", () => {
    const { units } = buildReview(plan, index);
    expect(units.map((u) => u.kept)).toEqual([false, true, true]);
  });

  it("inclui as dropadas — é o que permite restaurar sem re-planejar", () => {
    expect(buildReview(plan, index).units[0]).toEqual({
      id: "u001", text: "Eu esqueci o começo.", kept: false,
    });
  });

  it("leva o texto dos dois lados da junção", () => {
    const [join] = buildReview(plan, index).joins;
    expect(join!.outgoingTail).toBe("pra você.");
    expect(join!.incomingHead).toBe("Primeira coisa");
  });

  it("preserva os flags como objetos, com o hint", () => {
    // Achatar para string jogaria fora o hint, que é a única parte acionável.
    const [join] = buildReview(plan, index).joins;
    expect(join!.flags[0]!.code).toBe("mid_thought_out");
    expect(join!.flags[0]!.hint).toBe("Estenda o clipe.");
  });

  it("ancora a junção na unidade de saída", () => {
    expect(buildReview(plan, index).joins[0]!.afterUnitId).toBe("u002");
  });

  it("copia as durações do plano", () => {
    const review = buildReview(plan, index);
    expect(review.outputSeconds).toBe(12);
    expect(review.sourceSeconds).toBe(40);
  });

  it("aguenta plano sem junção nenhuma", () => {
    expect(buildReview({ ...plan, joins: [] }, index).joins).toEqual([]);
  });

  it("aguenta join sem flags", () => {
    const semFlags = { ...plan, joins: [{ ...plan.joins[0], flags: undefined }] };
    expect(buildReview(semFlags, index).joins[0]!.flags).toEqual([]);
  });

  it("estoura em índice sem units em vez de devolver review vazio", () => {
    expect(() => buildReview(plan, { units: [] })).toThrow(/units/);
  });
});
