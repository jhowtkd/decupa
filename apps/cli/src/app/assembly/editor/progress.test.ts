import { expect, it } from "vitest";
import { reviewView, watchProgress } from "./progress.js";

const p = (over: Record<string, unknown> = {}) => ({
  revision: 15, previewRevision: 15, finalApprovedRevision: null, scenes: [{ id: "s1" }], ...over,
});

it("watchProgress mede até onde a prévia foi vista", () => {
  expect(watchProgress(14.6, 73.12, false)).toEqual({ ratio: 14.6 / 73.12, label: "vista até 0:14 de 1:13" });
  expect(watchProgress(99, 73.12, false).ratio).toBe(1);
  expect(watchProgress(10, Number.NaN, false)).toEqual({ ratio: 0, label: "" });
  expect(watchProgress(0, 73.12, true)).toEqual({ ratio: 1, label: "vista até o fim" });
});

it("reviewView explica o gate: assistir até o fim, desatualizada, pronta, aprovada", () => {
  const progress = { ratio: 0.2, label: "vista até 0:14 de 1:13" };
  expect(reviewView(p(), { fresh: true, watched: false }, progress)).toEqual({
    visible: true, title: "Assista até o fim para aprovar",
    detail: "Prévia v15 · vista até 0:14 de 1:13 · voltar reinicia a contagem", ratio: 0.2,
  });
  expect(reviewView(p({ previewRevision: 14 }), { fresh: false, watched: false }, progress))
    .toMatchObject({ title: "Prévia desatualizada", detail: "Prévia v14 · a versão atual é v15", ratio: 0 });
  expect(reviewView(p(), { fresh: true, watched: true }, progress)).toMatchObject({ title: "Pronta para aprovar", ratio: 1 });
  expect(reviewView(p({ finalApprovedRevision: 15 }), { fresh: true, watched: true }, progress))
    .toMatchObject({ title: "Prévia aprovada", detail: "v15 · assistida até o fim", ratio: 1 });
  expect(reviewView(p({ previewRevision: null }), { fresh: false, watched: false }, progress))
    .toMatchObject({ title: "A prévia ainda não está pronta" });
  expect(reviewView(p({ scenes: [] }), { fresh: true, watched: false }, progress).visible).toBe(false);
});
