import { expect, it } from "vitest";
import { deliveryChecklist, exportView } from "./rail.js";

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
