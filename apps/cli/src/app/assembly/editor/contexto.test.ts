// apps/cli/src/app/assembly/editor/contexto.test.ts
import { expect, it } from "vitest";
import { inspectorSections } from "./contexto.js";

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
