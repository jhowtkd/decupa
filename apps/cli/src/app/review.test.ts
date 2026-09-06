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
      id: "u001", text: "Eu esqueci o começo.", kept: false, flags: [],
      start: 0, end: 0,
    });
  });

  it("copia start/end da unidade e sourceIn/sourceOut da junção", () => {
    const timed = {
      ...index,
      units: [
        { id: "u001", index: 0, text: "Eu esqueci o começo.", start: 1.2, end: 3.4 },
        { id: "u002", index: 1, text: "Dicas pra você.", start: 10, end: 14 },
        { id: "u003", index: 2, text: "Primeira coisa.", start: 18, end: 22 },
      ],
    };
    const timedPlan = {
      ...plan,
      joins: [{ ...plan.joins[0], source_out: 14.0, source_in: 18.0 }],
    };
    const review = buildReview(timedPlan, timed);
    expect(review.units[1]).toMatchObject({ id: "u002", start: 10, end: 14 });
    expect(review.joins[0]).toMatchObject({ sourceOut: 14, sourceIn: 18 });
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

  it("sem visual_index o 3º argumento é opcional e os testes antigos seguem", () => {
    expect(buildReview(plan, index).joins[0]!.flags.some((f) => f.code === "visual_in_point")).toBe(false);
  });

  it("marca visual_in_point quando o sample da entrada tem mão no rosto", () => {
    const planComTempo = {
      ...plan,
      joins: [{ ...plan.joins[0], source_out: 10.0, source_in: 12.0 }],
    };
    const visual = {
      units: [
        {
          id: "u002",
          look_down_ratio: 0,
          look_side_ratio: 0,
          hand_on_face_ratio: 0,
          face_missing_ratio: 0,
          samples: [
            { t: 9.9, look_down: false, look_side: false, hand_on_face: false, face: true },
          ],
        },
        {
          id: "u003",
          look_down_ratio: 0,
          look_side_ratio: 0,
          hand_on_face_ratio: 0.3,
          face_missing_ratio: 0,
          samples: [
            { t: 11.9, look_down: false, look_side: false, hand_on_face: true, face: true },
            { t: 12.4, look_down: false, look_side: false, hand_on_face: false, face: true },
          ],
        },
      ],
    };
    const [join] = buildReview(planComTempo, index, visual).joins;
    const flag = join!.flags.find((f) => f.code === "visual_in_point");
    expect(flag).toBeDefined();
    expect(flag!.hint).toBe("entra com a mão no rosto; mova o in-point +0,4s");
    expect(flag!.message).toMatch(/mão no rosto/);
  });

  it("marca visual_in_point em look_down ou sem rosto no in-point", () => {
    const planComTempo = {
      ...plan,
      joins: [{ ...plan.joins[0], source_out: 10.0, source_in: 12.0, flags: [] }],
    };
    const visual = {
      units: [{
        id: "u003",
        look_down_ratio: 0.4,
        look_side_ratio: 0,
        hand_on_face_ratio: 0,
        face_missing_ratio: 0,
        samples: [{ t: 12.0, look_down: true, look_side: false, hand_on_face: false, face: true }],
      }],
    };
    const flag = buildReview(planComTempo, index, visual).joins[0]!.flags.find((f) => f.code === "visual_in_point");
    expect(flag!.hint).toMatch(/in-point \+0,4s/);
  });

  it("propaga flags visuais da unidade e extraFlags de inspect", () => {
    const visual = {
      units: [{
        id: "u002",
        look_down_ratio: 0.6,
        look_side_ratio: 0,
        hand_on_face_ratio: 0,
        face_missing_ratio: 0,
        samples: [],
      }],
    };
    const extra = {
      u003: [{ code: "looks_away", source: "visual", message: "inspect: olhou para o operador" }],
    };
    const { units } = buildReview(plan, index, visual, extra);
    expect(units.find((u) => u.id === "u002")!.flags.some((f) => f.code === "looks_away")).toBe(true);
    expect(units.find((u) => u.id === "u003")!.flags[0]!.message).toMatch(/inspect/);
    expect(units.find((u) => u.id === "u001")!.flags).toEqual([]);
  });
});

