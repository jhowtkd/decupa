// apps/cli/src/app/assembly/editor/baseline.test.ts
import { expect, it } from "vitest";
import { watchedState } from "./watched.js";
import { createState } from "./state.js";

function project(over: Record<string, unknown> = {}) {
  return { revision: 5, previewRevision: 5, ...over };
}

it("aprovação exige prévia atual assistida até o fim", () => {
  expect(watchedState(project(), { revision: 5, ended: true }).canApprove).toBe(true);
  expect(watchedState(project(), { revision: 5, ended: false }).canApprove).toBe(false);
  expect(watchedState(project(), { revision: 4, ended: true }).canApprove).toBe(false);
});

it("sem prévia ou prévia obsoleta: bloqueia com rótulo próprio", () => {
  expect(watchedState(project({ previewRevision: null }), { revision: 5, ended: true }))
    .toMatchObject({ fresh: false, canApprove: false, label: "renderizando…" });
  expect(watchedState(project({ revision: 6 }), { revision: 5, ended: true }))
    .toMatchObject({ fresh: false, canApprove: false });
});

it("nova revisão invalida o assistido no state", () => {
  const state = createState({ project: project(), watched: { revision: 5, ended: true } });
  state.set("project", project({ revision: 6, previewRevision: 5 }));
  expect(state.get("watched")).toEqual({ revision: null, ended: false });
});
