import { expect, it } from "vitest";
import { watchedState } from "./watched.js";

it("sem prévia ainda mostra renderizando sem liberar aprovação", () => {
  expect(
    watchedState({ previewRevision: null, revision: 0 }, { revision: null, ended: false }),
  ).toEqual({ fresh: false, watched: false, canApprove: false, label: "renderizando…" });
});

it("prévia de revisão antiga pede atualização", () => {
  expect(
    watchedState({ previewRevision: 2, revision: 3 }, { revision: null, ended: false }),
  ).toEqual({ fresh: false, watched: false, canApprove: false, label: "desatualizada — atualizar" });
});

it("assistir a prévia antiga não vale depois de editar", () => {
  expect(
    watchedState({ previewRevision: 2, revision: 3 }, { revision: 2, ended: true }),
  ).toEqual({ fresh: false, watched: false, canApprove: false, label: "desatualizada — atualizar" });
});

it("prévia atual não assistida até o fim não libera aprovação", () => {
  expect(
    watchedState({ previewRevision: 3, revision: 3 }, { revision: null, ended: false }),
  ).toEqual({ fresh: true, watched: false, canApprove: false, label: "prévia atualizada ✓" });
});

it("terminar o vídeo de outra revisão não conta como assistida", () => {
  expect(
    watchedState({ previewRevision: 3, revision: 3 }, { revision: 2, ended: true }),
  ).toEqual({ fresh: true, watched: false, canApprove: false, label: "prévia atualizada ✓" });
});

it("assistir a prévia atual até o fim libera aprovação", () => {
  expect(
    watchedState({ previewRevision: 3, revision: 3 }, { revision: 3, ended: true }),
  ).toEqual({ fresh: true, watched: true, canApprove: true, label: "assistida ✓" });
});
