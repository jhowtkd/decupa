import { expect, it } from "vitest";
import { idleStatus, stepperState, versionLabel } from "./topbar.js";

const base = { revision: 15, previewRevision: null as number | null, finalApprovedRevision: null as number | null,
  assembly: { sources: [] as { included: boolean }[] } };

function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

it("sem projeto: materiais atual, nada feito, entrega travada", () => {
  const s = byId(stepperState(null, "materiais"));
  expect(s.materiais).toMatchObject({ current: true, done: false });
  expect(s.edicao).toMatchObject({ current: false, done: false });
  expect(s.entrega).toMatchObject({ locked: true });
});

it("fonte incluída marca materiais como feito quando a etapa atual é outra", () => {
  const s = byId(stepperState({ ...base, assembly: { sources: [{ included: true }] } }, "edicao"));
  expect(s.materiais.done).toBe(true);
  expect(s.edicao).toMatchObject({ current: true, done: false });
  expect(s.entrega.locked).toBe(true);
});

it("versão atual aprovada: edição e revisão feitas, entrega destravada", () => {
  const p = { ...base, previewRevision: 15, finalApprovedRevision: 15, assembly: { sources: [{ included: true }] } };
  const s = byId(stepperState(p, "entrega"));
  expect(s.edicao.done && s.revisao.done).toBe(true);
  expect(s.entrega).toMatchObject({ current: true, locked: false, done: false });
});

it("aprovação de versão antiga não destrava a entrega", () => {
  const s = byId(stepperState({ ...base, finalApprovedRevision: 14 }, "revisao"));
  expect(s.entrega.locked).toBe(true);
  expect(s.edicao.done).toBe(false);
});

it("versão e status ocioso", () => {
  expect(versionLabel(base)).toBe("v15");
  expect(idleStatus(base)).toEqual({ text: "v15", tone: "" });
  expect(idleStatus({ ...base, previewRevision: 15 })).toEqual({ text: "Prévia v15 pronta", tone: "ok" });
  expect(idleStatus({ ...base, previewRevision: 15, finalApprovedRevision: 15 })).toEqual({ text: "v15 aprovada", tone: "ok" });
  expect(idleStatus(null)).toEqual({ text: "carregando…", tone: "" });
});
