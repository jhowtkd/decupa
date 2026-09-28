// apps/cli/src/app/assembly/editor/contexto.test.ts
import { expect, it } from "vitest";
import { inspectorSections, pendingItems } from "./contexto.js";

function project(over: Record<string, unknown> = {}) {
  return { revision: 5, previewRevision: 5, finalApprovedRevision: null, corrections: [], ...over };
}

it("conta correções não alinhadas e estado de prévia/aprovação", () => {
  expect(inspectorSections(project())).toEqual({ corrections: 0, hasPreview: true, approved: false });
  expect(inspectorSections(project({
    corrections: [{ status: "pending" }, { status: "error" }, { status: "aligned" }],
  }))).toMatchObject({ corrections: 2 });
  expect(inspectorSections(project({ previewRevision: null }))).toMatchObject({ hasPreview: false });
  expect(inspectorSections(project({ finalApprovedRevision: 5 }))).toMatchObject({ approved: true });
  expect(inspectorSections(project({ finalApprovedRevision: 4 }))).toMatchObject({ approved: false });
});

it("sem projeto: tudo zerado", () => {
  expect(inspectorSections(null)).toEqual({ corrections: 0, hasPreview: false, approved: false });
});

it("pendingItems junta correções, lacunas e animações a fazer, sem as alinhadas", () => {
  const items = pendingItems({
    corrections: [
      { status: "aligned", sourceId: "a", start: 1, end: 2 },
      { status: "pending", sourceId: "a", start: 19.1, end: 19.9 },
      { status: "error", sourceId: "b", start: 3, end: 4.5, error: "sem áudio" },
    ],
    scenes: [
      { id: "s1", gaps: [], animationNotes: [] },
      { id: "s2", gaps: ["menção ao próximo vídeo sem referência na tela"], animationNotes: [{ description: "título animado", destination: "After Effects" }] },
    ],
  });
  expect(items).toEqual([
    { tone: "running", title: "Alinhando correção", detail: "a 19,1–19,9 s · o trecho original segue valendo até terminar." },
    { tone: "error", title: "Correção com erro", detail: "b 3,0–4,5 s · sem áudio. O texto original segue valendo." },
    { tone: "error", title: "Cena 2", detail: "Lacuna: menção ao próximo vídeo sem referência na tela" },
    { tone: "info", title: "Animação no After Effects", detail: "título animado" },
  ]);
  expect(pendingItems(null)).toEqual([]);
});
