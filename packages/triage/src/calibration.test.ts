import { describe, expect, it } from "vitest";
import { authorizesCut } from "@decupa/typesafe";
import { buildEditCatalog } from "./catalog.ts";
import {
  CRITICAL_CORPUS,
  DECISION_CATEGORIES,
  defaultCalibrationConfig,
  evaluateCase,
  humanLabelFromModels,
  proposalFromNoul,
  reportCalibration,
  type CalibrationCase,
  type DecisionCategory,
  type MachineProposal,
} from "./calibration.ts";

function byCategory(category: DecisionCategory): CalibrationCase {
  const found = CRITICAL_CORPUS.find((c) => c.category === category);
  if (!found) throw new Error(`corpus sem ${category}`);
  return found;
}

describe("corpus crítico", () => {
  it("cobre os sete casos editoriais com julgamento humano", () => {
    expect(DECISION_CATEGORIES).toEqual([
      "condition_removed",
      "negation",
      "pode_vs_e",
      "number",
      "retake",
      "intentional_repetition",
      "unanswered_question",
    ]);
    expect(new Set(CRITICAL_CORPUS.map((c) => c.category))).toEqual(new Set(DECISION_CATEGORIES));
    expect(CRITICAL_CORPUS.every((c) => c.human.by === "human")).toBe(true);
  });

  it("separa dev e avaliação por vídeo e por projeto", () => {
    const devVideos = new Set(CRITICAL_CORPUS.filter((c) => c.split === "dev").map((c) => c.videoId));
    const evalVideos = new Set(CRITICAL_CORPUS.filter((c) => c.split === "eval").map((c) => c.videoId));
    const devProjects = new Set(CRITICAL_CORPUS.filter((c) => c.split === "dev").map((c) => c.projectId));
    const evalProjects = new Set(CRITICAL_CORPUS.filter((c) => c.split === "eval").map((c) => c.projectId));
    for (const id of evalVideos) expect(devVideos.has(id)).toBe(false);
    for (const id of evalProjects) expect(devProjects.has(id)).toBe(false);
    expect(devVideos.size).toBeGreaterThan(0);
    expect(evalVideos.size).toBeGreaterThan(0);
  });

  it("cada caso ancora um candidato do catálogo fechado", async () => {
    for (const cse of CRITICAL_CORPUS) {
      const catalog = await buildEditCatalog(cse.index);
      const hit = catalog.candidates.find((c) => c.id === cse.candidateId);
      expect(hit, cse.caseId).toBeDefined();
      expect(hit?.unitIds).toEqual(cse.targetUnitIds);
    }
  });
});

describe("calibração", () => {
  it("enabledCategories começa vazio e vira trabalho humano", () => {
    expect(defaultCalibrationConfig().enabledCategories).toEqual([]);
    const cse = byCategory("negation");
    const evaled = evaluateCase(cse, { source: "typesafe", apply: true, latencyMs: 12 }, defaultCalibrationConfig());
    expect(evaled.outcome).toBe("human_work");
  });

  it("conta remoção incorreta, omissão, abstinência e fallback contra o humano", () => {
    const negation = byCategory("negation");
    const enabled = { enabledCategories: ["negation"] as const };
    expect(evaluateCase(negation, { source: "typesafe", apply: true, latencyMs: 8 }, enabled).outcome)
      .toBe("incorrect_removal");
    const retake = byCategory("retake");
    expect(evaluateCase(retake, { source: "typesafe", apply: false, latencyMs: 9 }, {
      enabledCategories: ["retake"],
    }).outcome).toBe("omission");
    expect(evaluateCase(negation, { source: "typesafe", apply: false, latencyMs: 4, abstained: true }, enabled).outcome)
      .toBe("abstention");
    expect(evaluateCase(negation, { source: "typesafe", apply: false, latencyMs: 40, fallback: true }, enabled).outcome)
      .toBe("fallback");
  });

  it("concordância com outro modelo não vira verdade", () => {
    const cse = byCategory("number");
    expect(humanLabelFromModels(
      { source: "typesafe", apply: true, latencyMs: 1 },
      { source: "other-model", apply: true, latencyMs: 1 },
    )).toBeNull();
    expect(cse.human.by).toBe("human");
    expect(cse.human.apply).toBe(false);
    const agreed: MachineProposal = { source: "other-model", apply: true, latencyMs: 5 };
    expect(evaluateCase(cse, agreed, { enabledCategories: ["number"] }).outcome).toBe("incorrect_removal");
  });

  it("noul do TypeSafe só corta acima do limiar isolado", () => {
    expect(authorizesCut(0.51)).toBe(false);
    expect(proposalFromNoul(0.51, 3).apply).toBe(false);
    expect(proposalFromNoul(0.9, 3).apply).toBe(true);
  });

  it("relatório de latência e qualidade só libera categoria no conjunto de avaliação", () => {
    const evalCases = CRITICAL_CORPUS.filter((c) => c.split === "eval");
    const results = evalCases.map((cse) => evaluateCase(
      cse,
      {
        source: "typesafe",
        apply: cse.human.apply,
        latencyMs: cse.category === "retake" ? 20 : 10,
      },
      { enabledCategories: DECISION_CATEGORIES },
    ));
    const report = reportCalibration(results);
    expect(report.sampleSize).toBe(evalCases.length);
    expect(report.latency.p50Ms).toBeGreaterThan(0);
    expect(report.latency.p95Ms).toBeGreaterThanOrEqual(report.latency.p50Ms);
    expect(report.counts.incorrect_removal).toBe(0);
    expect(report.counts.human_work).toBe(0);
    expect(report.unlockedCategories.sort()).toEqual(
      [...new Set(evalCases.map((c) => c.category))].sort(),
    );

    const withError = reportCalibration([
      ...results,
      evaluateCase(
        byCategory("negation"),
        { source: "typesafe", apply: true, latencyMs: 11 },
        { enabledCategories: ["negation"] },
      ),
    ]);
    expect(withError.unlockedCategories).not.toContain("negation");
  });
});
