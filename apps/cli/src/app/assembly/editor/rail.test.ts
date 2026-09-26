import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { briefingSummary, countsFor, deliveryChecklist, deliveryFormats, exportView, formatLabel, paintSceneCurrent, preparationSteps, preparationView, primaryAction, sameSceneNav, sceneNavItems, sourceProgress, sourceStatusText, stageLabel, verifyView } from "./rail.js";

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
  expect(sourceProgress(p, source)).toMatchObject({ tone: "cancelled", label: "Cancelada" });
});

it("preparação cancelada: material e resumo neutros; interrompida e atenção continuam erro", () => {
  const source = { id: "a", name: "fala.mp4", included: true, hasVideo: true };
  const at = (status: string) => ({
    assembly: { sources: [source] }, analyses: [{ sourceId: "a", status: "ready" }],
    preparation: { status, stage: "visual", sources: { a: { media: "ready", audio: "ready", visual: "pending" } } },
  });
  const cancelled = sourceProgress(at("cancelled"), source);
  expect(cancelled).toMatchObject({ tone: "cancelled", label: "Cancelada" });
  expect(sourceStatusText(cancelled)).toBe("Cancelada");
  expect(preparationView(at("cancelled"), null)).toMatchObject({
    tone: "cancelled", title: "Preparação cancelada",
    detail: "As etapas concluídas ficam guardadas. Retome para concluir o que falta.",
  });
  expect(sourceProgress(at("interrupted"), source)).toMatchObject({ tone: "error", label: "Preparação interrompida" });
  expect(preparationView(at("interrupted"), null)).toMatchObject({
    tone: "error", title: "A montagem precisa de atenção", detail: "fala.mp4 · Retome para concluir as etapas pendentes.",
  });
  expect(preparationView(at("attention"), null)).toMatchObject({ tone: "error", title: "A montagem precisa de atenção" });
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

  it("preparação pronta sem cortes → Revisar prévia (gratuito)", () => {
    expect(primaryAction(project({
      assembly: { sources: [{ id: "a", included: true }], tracks: [] },
      preparation: prep({ a: {} }),
    }), null)).toMatchObject({ kind: "revisar", label: "Revisar prévia", stage: "revisao" });
  });

  it("montagem existente não aprovada → Revisar prévia, sem POST", () => {
    expect(primaryAction(project({
      revision: 5,
      assembly: { sources: [{ id: "a", included: true }], ...withClips },
      preparation: prep({ a: {} }),
      finalApprovedRevision: null,
    }), null)).toMatchObject({ kind: "revisar", label: "Revisar prévia", stage: "revisao" });
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

it("material pronto some do rail; preparo e erro continuam visíveis", () => {
  const source = { id: "a", name: "fala.mp4", included: true, hasVideo: true };
  const base = { assembly: { sources: [source] }, analyses: [{ sourceId: "a", status: "ready" }] };
  const ready = sourceProgress({ ...base, preparation: { status: "ready", sources: { a: { media: "ready", audio: "ready", visual: "ready" } } } }, source);
  expect(ready).toMatchObject({ tone: "ready", label: "Análise concluída" });
  expect(sourceStatusText(ready)).toBe("");
  const transcript = sourceProgress({ ...base, preparation: { status: "running", stage: "visual", sources: { a: { media: "ready", audio: "ready", visual: "pending" } } } }, source);
  expect(transcript.label).toBe("Transcrição disponível");
  expect(sourceStatusText(transcript)).toBe("");
  const running = sourceProgress({ ...base, preparation: { status: "running", stage: "visual", sources: { a: { media: "ready", audio: "ready", visual: "running" } } } }, source);
  expect(sourceStatusText(running)).toBe("Analisar imagens…");
  const failed = sourceProgress({ ...base, preparation: { status: "interrupted", stage: "visual", sources: { a: { media: "ready", audio: "ready", visual: "error", error: "intervalo inválido" } } } }, source);
  expect(sourceStatusText(failed)).toBe("Analisar imagens: falhou");
});

function sceneLink(id: string, current = false) {
  const attrs = new Map<string, string>();
  if (current) attrs.set("aria-current", "true");
  return {
    dataset: { scene: id },
    setAttribute(name: string, value: string) { attrs.set(name, value); },
    removeAttribute(name: string) { attrs.delete(name); },
    getAttribute(name: string) { return attrs.get(name) ?? null; },
    hasAttribute(name: string) { return attrs.has(name); },
  };
}

it("troca de cena move o aria-current no link existente", () => {
  const scenes = [
    { id: "s1", objective: "Gancho", gaps: [], takes: [{ start: 0, end: 10, removed: [] }] },
    { id: "s2", objective: "Corte", gaps: [], takes: [{ start: 10, end: 20, removed: [] }] },
  ];
  const items = sceneNavItems({ scenes });
  expect(sameSceneNav(items, sceneNavItems({ scenes }))).toBe(true);
  expect(sameSceneNav(items, sceneNavItems({ scenes: [{ ...scenes[0], objective: "Outro" }, scenes[1]] }))).toBe(false);
  const first = sceneLink("s1", true);
  const second = sceneLink("s2");
  paintSceneCurrent([first, second], "s2");
  expect(first.hasAttribute("aria-current")).toBe(false);
  expect(second.getAttribute("aria-current")).toBe("true");
  expect(first.dataset.scene).toBe("s1");
  expect(second.dataset.scene).toBe("s2");
});

it("seleção de material tem nome e alvo de 24px visível sem hover", async () => {
  const rail = await readFile(new URL("./rail.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../page.css", import.meta.url), "utf8");
  expect(rail).toContain('check.className = "source-check"');
  expect(rail).toContain('checkName.textContent = "Selecionar " + source.name');
  expect(rail).toContain("paintSceneCurrent(links, current)");
  expect(css).toContain(".source-check { position: absolute; left: 0; top: 0; z-index: 1; display: grid; place-items: center; width: 24px; height: 24px; margin: 0; }");
  expect(css).toContain(".source-check input { width: 24px; height: 24px; margin: 0; padding: 0; accent-color: var(--accent); opacity: 0; }");
  expect(css).toContain("@media (hover: none), (pointer: coarse), (max-width: 700px)");
  expect(css).toContain(".source[data-status=\"ready\"] .source-status { display: none; }");
});

it("sceneNavItems numera as cenas e soma o início pela fala retida", () => {
  const items = sceneNavItems({
    scenes: [
      { id: "s1", objective: "Gancho e promessa", gaps: [], takes: [{ start: 0.4, end: 25.2, removed: [{ start: 11, end: 14.5 }] }] },
      { id: "s2", objective: "", gaps: ["sem imagem"], takes: [{ start: 32.1, end: 54.8, removed: [] }] },
    ],
  });
  expect(items.map((i: { number: number }) => i.number)).toEqual([1, 2]);
  expect(items[0]).toMatchObject({ id: "s1", title: "Gancho e promessa", start: 0, warn: false });
  expect(items[1]).toMatchObject({ id: "s2", title: "s2", warn: true });
  expect(items[1].start).toBeCloseTo(21.3, 5);
  expect(sceneNavItems(null)).toEqual([]);
});

it("briefingSummary compara a duração com o alvo", () => {
  const over = briefingSummary({ text: "aula", targetSeconds: 60 }, 73.12);
  expect(over).toMatchObject({ text: "aula", target: 60, duration: 73.12, note: "13 s acima do alvo" });
  expect(over.fill).toBeCloseTo(60 / 73.12, 5);
  expect(briefingSummary({ text: "", targetSeconds: 60 }, 45).note).toBe("15 s abaixo do alvo");
  expect(briefingSummary({ text: "", targetSeconds: 60 }, 60.2).note).toBe("No alvo");
  expect(briefingSummary({ text: "x", targetSeconds: 60 }, null)).toMatchObject({ duration: null, note: "", fill: 0 });
});

it("preparationSteps: cancelada pelo usuário fica neutra; falha real continua Falhou", () => {
  const preparation = { status: "running", stage: "visual", sources: { a: { media: "ready", audio: "ready", visual: "running" } } };
  const running = project({
    assembly: { sources: [{ id: "a", name: "fala.mp4", included: true }] },
    previewRevision: null,
    preparation,
  });
  expect(preparationSteps(running, true).map((step: { status: string; state: string }) => [step.status, step.state])).toEqual([
    ["ready", "Concluída"], ["ready", "Concluída"], ["running", "Em andamento · fala.mp4"], ["pending", "Na fila"], ["pending", "Na fila"],
  ]);
  const stopped = (status: string) => ({ ...running, preparation: { ...preparation, status } });
  expect(preparationSteps(stopped("cancelled"), false)[2]).toMatchObject({ key: "visual", status: "cancelled", state: "Cancelada" });
  expect(preparationSteps(stopped("interrupted"), false)[2]).toMatchObject({ key: "visual", status: "error", state: "Falhou" });
  expect(preparationSteps(stopped("attention"), false)[2]).toMatchObject({ status: "error", state: "Falhou" });
  expect(preparationSteps(project(), false)).toEqual([]);
});

describe("entrega", () => {
  const aprovado = { revision: 15, finalApprovedRevision: 15 };

  it("arquivos só aparecem depois da exportação da versão aprovada", () => {
    expect(deliveryFormats(aprovado, null)).toEqual([]);
    expect(deliveryFormats({ revision: 16, finalApprovedRevision: 15 }, { revision: 15, status: "pendente" })).toEqual([]);
    const files = deliveryFormats(aprovado, { revision: 15, status: "pendente" });
    expect(files.map((f: { file: string }) => f.file)).toEqual(["timeline.otio", "reference.mp4", "importar-no-resolve.txt", "verificacao.json"]);
    expect(files[0].href).toBe("/project/output/15/otio");
  });

  it("verifyView guia do bloqueio à conferência", () => {
    expect(verifyView({ revision: 15, finalApprovedRevision: null }, null)).toMatchObject({ state: "locked", showExport: true, showConfirm: false });
    expect(verifyView(aprovado, null)).toMatchObject({ state: "ready", title: "Preparar a entrega da v15", showExport: true });
    expect(verifyView(aprovado, { revision: 15, status: "pendente" })).toMatchObject({
      state: "pending", title: "Conferência pendente", detail: "Importe a versão 15 no Resolve e confira a timeline.",
      showExport: false, showConfirm: true,
    });
    expect(verifyView(aprovado, { revision: 15, status: "confirmada" })).toMatchObject({ state: "done", showConfirm: false });
  });
});
