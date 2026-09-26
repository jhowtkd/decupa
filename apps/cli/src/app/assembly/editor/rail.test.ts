import { describe, expect, it } from "vitest";
import { countsFor, deliveryChecklist, exportView, formatLabel, primaryAction, stageLabel, sourceProgress, preparationView } from "./rail.js";

function project(over: Record<string, unknown> = {}) {
  return {
    revision: 0,
    assembly: { sources: [] as { included: boolean }[] },
    scenes: [] as unknown[],
    finalApprovedRevision: null as number | null,
    ...over,
  };
}

it("projeto vazio: checklist todo pendente", () => {
  expect(deliveryChecklist(project())).toEqual([
    { id: "media", label: "Mídia presente", done: false },
    { id: "selection", label: "Seleção feita", done: false },
    { id: "review", label: "Revisão pronta", done: false },
  ]);
});

it("mídia incluída marca mídia e seleção, revisão segue pendente", () => {
  const items = deliveryChecklist(project({
    assembly: { sources: [{ included: true }] },
  }));
  expect(items.map((i) => i.done)).toEqual([true, true, false]);
});

it("fontes todas excluídas: mídia presente mas seleção pendente", () => {
  const items = deliveryChecklist(project({
    assembly: { sources: [{ included: false }] },
  }));
  expect(items.map((i) => i.done)).toEqual([true, false, false]);
});

it("aprovação final marca a revisão como pronta", () => {
  const items = deliveryChecklist(project({
    assembly: { sources: [{ included: true }] },
    finalApprovedRevision: 3,
  }));
  expect(items.map((i) => i.done)).toEqual([true, true, true]);
});

it("ocioso sem aprovação: botão desabilitado, sem spinner nem mensagem", () => {
  expect(exportView({ status: "idle", error: null }, false)).toEqual({
    disabled: true, loading: false, tone: "idle",
    buttonLabel: "Exportar revisão", statusText: "",
  });
});

it("ocioso com aprovação: botão liberado", () => {
  const view = exportView({ status: "idle", error: null }, true);
  expect(view.disabled).toBe(false);
  expect(view.loading).toBe(false);
  expect(view.tone).toBe("idle");
});

it("em progresso: desabilitado com spinner e rótulo próprios", () => {
  expect(exportView({ status: "running", error: null }, true)).toEqual({
    disabled: true, loading: true, tone: "running",
    buttonLabel: "Exportando…", statusText: "Exportando…",
  });
});

it("concluído: rótulo e mensagem de conclusão distinguíveis", () => {
  expect(exportView({ status: "done", error: null }, true)).toEqual({
    disabled: false, loading: false, tone: "done",
    buttonLabel: "Exportado ✓", statusText: "Exportado ✓ — links abaixo.",
  });
});

it("erro: mensagem do servidor visível e botão liberado para tentar de novo", () => {
  expect(exportView({ status: "error", error: "aprovação final desatualizada" }, true)).toEqual({
    disabled: false, loading: false, tone: "error",
    buttonLabel: "Exportar revisão",
    statusText: "Erro no export: aprovação final desatualizada",
  });
});

it("countsFor resume fontes/incluídas/apoio", () => {
  expect(countsFor([])).toEqual({ total: 0, included: 0, support: 0 });
  expect(countsFor([
    { included: true, role: "speech" },
    { included: false, role: "support" },
    { included: true, role: "both" },
  ])).toEqual({ total: 3, included: 2, support: 2 });
});

it("exportView sem formatos preserva o contrato antigo", () => {
  expect(exportView({ status: "idle", error: null }, true)).not.toHaveProperty("formats");
});

it("exportView com formatos ecoa capacidades", () => {
  const formats = [{ id: "otio", label: "Baixar timeline.otio", href: "/project/output/3/otio", file: "timeline.otio" }];
  expect(exportView({ status: "done", error: null }, true, formats)).toMatchObject({ tone: "done", formats });
});

it("stageLabel traduz etapas e repassa desconhecidas", () => {
  expect(stageLabel("rendering")).toBe("Renderizando prévia");
  expect(stageLabel("cancelled")).toBe("Cancelada");
  expect(stageLabel("weird-stage")).toBe("weird-stage");
});


it("falha visual prevalece sobre transcrição pronta e operação ready", () => {
  const source = { id: "a", name: "entrevista.mov", included: true, hasVideo: true };
  const p = { assembly: { sources: [source] }, analyses: [{ sourceId: "a", status: "ready" }],
    preparation: { status: "interrupted", stage: "visual", sources: { a: { media: "ready", audio: "ready", visual: "error", error: "intervalo inválido" } } } };
  expect(sourceProgress(p, source)).toMatchObject({ tone: "error", label: "Analisar imagens: falhou" });
  expect(preparationView(p, { stage: "ready" })).toMatchObject({ tone: "error", busy: false, done: 0, detail: "entrevista.mov · intervalo inválido" });
  p.preparation.status = "running";
  p.preparation.sources.a.visual = "running";
  expect(sourceProgress(p, source)).toMatchObject({ tone: "running", label: "Analisar imagens…" });
  p.preparation.status = "cancelled";
  expect(sourceProgress(p, source).label).toBe("Preparação interrompida");
});

it("Resolve apresenta etapa e bloqueia revisão não aprovada", async()=>{
 const {resolveView}=await import("./rail.js");
 expect(resolveView({status:"running",stage:"imported"},true)).toMatchObject({disabled:true,statusText:"Verificando timeline importada…"});
 expect(resolveView({status:"ready",projectName:"P-r1"},true)).toMatchObject({disabled:false,statusText:"Projeto salvo: P-r1"});
 expect(resolveView({status:"error",error:"Resolve indisponível"},true)).toMatchObject({statusText:"Resolve indisponível",newCopy:true});
 expect(resolveView(null,false).disabled).toBe(true);
});

describe("primaryAction — montar/preparar/revisar/entregar", () => {
  const withClips = { tracks: [{ clips: [{ id: "c1" }] }] };
  const prep = (sources: Record<string, unknown>, status = "ready") =>
    ({ status, sources });

  it("operação em voo domina: rótulo da etapa e botão desabilitado", () => {
    expect(primaryAction(project(), { stage: "analyzing" }))
      .toMatchObject({ kind: "busy", label: "Analisando mídia…", disabled: true, stage: null });
  });

  it("sem fonte incluída fica Montar desabilitado", () => {
    expect(primaryAction(project(), null))
      .toMatchObject({ kind: "montar", disabled: true, stage: null });
  });

  it("fonte nova sem preparação → Montar habilitado", () => {
    expect(primaryAction(project({
      assembly: { sources: [{ id: "a", included: true }], tracks: [] },
    }), null)).toMatchObject({ kind: "montar", disabled: false, stage: null });
  });

  it("preparação interrompida → Retomar preparação (chamada real)", () => {
    expect(primaryAction(project({
      assembly: { sources: [{ id: "a", included: true }], tracks: [] },
      preparation: prep({ a: {} }, "interrupted"),
    }), null)).toMatchObject({ kind: "preparar", label: "Retomar preparação" });
  });

  it("preparação pronta sem cortes → Revisar montagem (gratuito)", () => {
    expect(primaryAction(project({
      assembly: { sources: [{ id: "a", included: true }], tracks: [] },
      preparation: prep({ a: {} }),
    }), null)).toMatchObject({ kind: "revisar", stage: "revisao" });
  });

  it("montagem existente não aprovada → Revisar montagem, sem POST", () => {
    expect(primaryAction(project({
      revision: 5,
      assembly: { sources: [{ id: "a", included: true }], ...withClips },
      preparation: prep({ a: {} }),
      finalApprovedRevision: null,
    }), null)).toMatchObject({ kind: "revisar", stage: "revisao" });
  });

  it("revisão aprovada → Abrir entrega navega para entrega", () => {
    expect(primaryAction(project({
      revision: 7,
      assembly: { sources: [{ id: "a", included: true }], ...withClips },
      preparation: prep({ a: {} }),
      finalApprovedRevision: 7,
    }), null)).toMatchObject({ kind: "entregar", stage: "entrega" });
  });

  it("fonte incluída sem análise registrada → Preparar montagem", () => {
    expect(primaryAction(project({
      assembly: { sources: [{ id: "a", included: true }, { id: "b", included: true }], ...withClips },
      preparation: prep({ a: {} }),
    }), null)).toMatchObject({ kind: "preparar", label: "Preparar montagem" });
  });
});

it("formatLabel resume dimensões, orientação e fps da entrega", () => {
  expect(formatLabel({ width: 1920, height: 1080, fps: { num: 25, den: 1 } }))
    .toBe("1920×1080 horizontal @ 25/1 fps");
  expect(formatLabel({ width: 1080, height: 1920, fps: { num: 30000, den: 1001 } }))
    .toBe("1080×1920 vertical @ 30000/1001 fps");
  expect(formatLabel({ width: 720, height: 720, fps: { num: 25, den: 1 } }))
    .toBe("720×720 quadrado @ 25/1 fps");
  expect(formatLabel(null)).toBe("");
});
