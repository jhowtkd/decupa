import { expect, it } from "vitest";
import { blankProject } from "./routes.ts";
import { buildTemplateReport } from "./template-report.ts";
import { fixtureAssembly } from "./fixture.ts";
import type { Project } from "./types.ts";
import type { Recipe } from "../templates/types.ts";

function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 3,
    name: "Evento",
    status: "approved",
    source: { path: "/tmp/ref.mp4", sha256: "a".repeat(64), durationSeconds: 2 },
    analysis: { status: "ready", stage: "complete" },
    rules: [
      { id: "r1", category: "narrative", observation: "abertura rápida", instruction: "abre com fala", enabled: true, confidence: "observed", evidence: [] },
      { id: "r2", category: "rhythm", observation: "ritmo seco", instruction: "corta pausas", enabled: true, confidence: "observed", evidence: [] },
      { id: "r3", category: "format", observation: "vertical", instruction: "9:16", enabled: false, confidence: "observed", evidence: [] },
    ],
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  const p = blankProject("p1");
  p.assembly = fixtureAssembly();
  p.scenes = [{
    id: "s1",
    objective: "abertura",
    rationale: "fala",
    speechIds: [],
    takes: [],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  }];
  return { ...p, ...over };
}

it("projeto sem template devolve relatório vazio", () => {
  expect(buildTemplateReport(project())).toEqual({ recipe: null, rules: [], animations: [] });
});

it("relatório usa a receita congelada no aceite, não a versão da biblioteca", () => {
  const p = project({ template: recipe(), templateReport: [
    { ruleId: "r1", status: "applied", reason: "cena de abertura segue a regra", sceneIds: ["s1", "s-apagada"] },
    { ruleId: "r2", status: "adapted", reason: "mantida pausa dramática" },
  ] });
  const report = buildTemplateReport(p);
  expect(report.recipe).toEqual({ id: recipe().id, revision: 3, name: "Evento" });
  expect(report.rules).toHaveLength(2); // regra desabilitada não entra
  expect(report.rules[0]).toMatchObject({ ruleId: "r1", status: "applied", sceneIds: ["s1"] });
  expect(report.rules[1]).toMatchObject({ ruleId: "r2", status: "adapted", sceneIds: null });
});

it("regra ativa sem resultado na proposta aparece explicitamente indisponível", () => {
  const p = project({ template: recipe(), templateReport: [
    { ruleId: "r1", status: "applied", reason: "ok" },
  ] });
  const report = buildTemplateReport(p);
  expect(report.rules.map((rule) => rule.ruleId)).toEqual(["r1", "r2"]);
  expect(report.rules[1]).toMatchObject({ status: "unavailable", reason: "sem resultado registrado na proposta aceita" });
});

it("animações pendentes saem como handoff com janela, nunca como efeito", () => {
  const p = project({ template: recipe(), templateReport: [] });
  p.scenes[0]!.animationNotes = [{ id: "n1", description: "lower third", destination: "Resolve" }];
  const report = buildTemplateReport(p);
  expect(report.animations).toEqual([
    { id: "n1", description: "lower third", destination: "Resolve", sceneId: "s1", startFrame: 0, durationFrames: 50 },
  ]);
});

it("nota de animação em cena sem clipes não derruba o relatório", () => {
  const p = project({ template: recipe(), templateReport: [] });
  p.scenes.push({ id: "s2", objective: "x", rationale: "x", speechIds: [], takes: [], visualEvidenceIds: [], support: [], gaps: [], animationNotes: [{ id: "n2", description: "anim", destination: "After Effects" }] });
  const report = buildTemplateReport(p);
  expect(report.animations).toEqual([]);
  expect(report.recipe?.id).toBe(recipe().id);
});
