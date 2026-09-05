import { describe, expect, it } from "vitest";
import { renderReport } from "./report.ts";

const base = {
  keepList: "u005-u031 u038-u041",
  model: "gemini-3.8-flash",
  verdicts: [
    {
      accepted: true as const,
      claim: {
        unit_ids: ["u001", "u002"],
        reason: "preroll" as const,
        restated_by: null,
        note: "falando com o operador",
        source: "model" as const,
      },
    },
    {
      accepted: false as const,
      failed: "pré-rolo invade o corpo do vídeo",
      claim: {
        unit_ids: ["u010"],
        reason: "preroll" as const,
        restated_by: null,
        note: "chute",
        source: "model" as const,
      },
    },
  ],
  density: null,
};

describe("renderReport", () => {
  it("mostra o keep-list pronto para colar", () => {
    expect(renderReport(base)).toContain("u005-u031 u038-u041");
  });

  it("lista alegação aceita com o motivo dado pelo modelo", () => {
    expect(renderReport(base)).toContain("falando com o operador");
  });

  it("lista alegação rejeitada com a condição que falhou", () => {
    const out = renderReport(base);
    expect(out).toContain("u010");
    expect(out).toContain("pré-rolo invade o corpo do vídeo");
  });

  it("diz que o passe de densidade não rodou quando não houve alvo", () => {
    expect(renderReport(base)).toMatch(/densidade.*não rodou|sem --target/i);
  });

  it("avisa quando nada foi reivindicado", () => {
    const out = renderReport({ ...base, verdicts: [] });
    expect(out).toMatch(/nada/i);
  });

  it("separa mecânico, modelo, visual e para revisão", () => {
    const out = renderReport({
      ...base,
      verdicts: [
        {
          accepted: true as const,
          claim: {
            unit_ids: ["u015"],
            reason: "retake" as const,
            restated_by: "u016",
            note: "retomada da mesma frase; fica u016",
            source: "mechanical" as const,
          },
        },
        ...base.verdicts,
      ],
      reviewFlags: [{
        unitId: "u020",
        code: "looks_away",
        source: "visual",
        message: "olhando para o operador, sem take substituto",
      }],
    });
    expect(out).toContain("## Mecânico");
    expect(out).toContain("## Modelo");
    expect(out).toContain("## Visual");
    expect(out).toContain("## Para revisão");
    expect(out).toContain("fica **u016** · sai **u015**");
    expect(out).toContain("u020");
    expect(out).toContain("sem take substituto");
  });

  it("renderiza candidatos do passe de densidade quando presentes", () => {
    const out = renderReport({
      ...base,
      density: {
        budgetSeconds: 12.5,
        applied: [{ unit_ids: ["u003"], rank: 1, note: "pausa longa" }],
        skipped: [{ candidate: { unit_ids: ["u004"], rank: 2, note: "exemplo prolixo" }, why: "estoura orçamento" }],
      },
    });
    expect(out).toContain("Orçamento: 12.5s");
    expect(out).toContain("**u003** (rank 1) — pausa longa");
    expect(out).toContain("~~u004~~ pulado: estoura orçamento");
  });
});
