import { expect, it } from "vitest";
import { approveButtonView, reviewView, watchProgress } from "./progress.js";

const p = (over: Record<string, unknown> = {}) => ({
  revision: 15, previewRevision: 15, finalApprovedRevision: null, scenes: [{ id: "s1" }], ...over,
});

it("watchProgress mede quanto da prévia foi tocado de fato (#103)", () => {
  expect(watchProgress(14.6, 73.12, false)).toEqual({ ratio: 14.6 / 73.12, label: "0:14 de 1:13 vistos" });
  expect(watchProgress(99, 73.12, false)).toEqual({ ratio: 0.99, label: "falta assistir um trecho" });
  expect(watchProgress(10, Number.NaN, false)).toEqual({ ratio: 0, label: "" });
  expect(watchProgress(0, 73.12, true)).toEqual({ ratio: 1, label: "vista até o fim" });
});

it("reviewView: prévia atual fica pronta para aprovar mesmo sem ter sido vista inteira", () => {
  const progress = { ratio: 0.2, label: "vista até 0:14 de 1:13" };
  expect(reviewView(p(), { fresh: true, watched: false }, progress)).toEqual({
    visible: true, title: "Pronta para aprovar",
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

it("sem ver tudo, o anel não chega a 100% nem diz que viu tudo", () => {
  // 73,00 s cobertos de 73,12 s, com um buraco em algum ponto: watched continua falso.
  const near = watchProgress(73, 73.12, false);
  expect(near).toEqual({ ratio: 0.99, label: "falta assistir um trecho" });
  expect(Math.round(near.ratio * 100)).toBe(99);
  expect(reviewView(p(), { fresh: true, watched: false }, near)).toEqual({
    visible: true, title: "Pronta para aprovar",
    detail: "Prévia v15 · falta assistir um trecho · voltar reinicia a contagem", ratio: 0.99,
  });
  // O 100% e o "vista até o fim" ficam para quando status.watched é verdadeiro.
  expect(watchProgress(73, 73.12, true)).toEqual({ ratio: 1, label: "vista até o fim" });
  expect(watchProgress(72.4, 73.12, false)).toEqual({ ratio: 0.99, label: "1:12 de 1:13 vistos" });
  // Seek direto para o fim sem tocar nada: a cobertura é zero, e o anel também.
  expect(watchProgress(0, 73.12, false)).toEqual({ ratio: 0, label: "0:00 de 1:13 vistos" });
});

it("approveButtonView: versão atual já aprovada mostra Aprovada, sem cadeado", () => {
  const locked = { canApprove: false };
  // Depois do reload o assistido zera, mas o servidor diz que a v15 está aprovada.
  expect(approveButtonView(p({ finalApprovedRevision: 15 }), locked, false))
    .toEqual({ label: "Aprovada", disabled: true, locked: false, icon: "check", approved: true });
  expect(approveButtonView(p({ finalApprovedRevision: 15 }), locked, true)).toMatchObject({ label: "Aprovada", locked: false });
  // Aprovação de versão antiga não conta: volta o gate de sempre.
  expect(approveButtonView(p({ revision: 16, finalApprovedRevision: 15 }), locked, false))
    .toEqual({ label: "Aprovar prévia", disabled: true, locked: true, icon: "lock", approved: false });
  expect(approveButtonView(p(), { canApprove: true }, false))
    .toEqual({ label: "Aprovar prévia", disabled: false, locked: false, icon: "check", approved: false });
  expect(approveButtonView(p(), { canApprove: true }, true)).toMatchObject({ disabled: true, locked: true, icon: "lock" });
});
