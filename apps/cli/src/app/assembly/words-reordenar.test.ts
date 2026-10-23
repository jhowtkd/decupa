// reorder-scenes (puro): validação da ordem, parse da ação, rótulo e aplicação.
import { expect, it } from "vitest";
import { editLabel } from "./undo.ts";
import type { Project } from "./types.ts";
import { applyTextEdit, parseEditAction, sceneOrderChanged } from "./words.ts";

const projeto = (ids: string[] = ["a", "b", "c"]) =>
  ({ scenes: ids.map((id) => ({ id, takes: [], support: [], gaps: [] })) }) as unknown as Project;

it("sceneOrderChanged: devolve se a ordem difere da atual", () => {
  const p = projeto();
  expect(sceneOrderChanged(p, ["a", "b", "c"])).toBe(false);
  expect(sceneOrderChanged(p, ["c", "a", "b"])).toBe(true);
  expect(sceneOrderChanged(p, ["b", "a", "c"])).toBe(true);
});

it("sceneOrderChanged: cena desconhecida, repetida ou faltando lança", () => {
  const p = projeto();
  expect(() => sceneOrderChanged(p, ["a", "b", "x"])).toThrow(/não encontrada: x/);
  expect(() => sceneOrderChanged(p, ["a", "b", "c", "x"])).toThrow(/não encontrada: x/);
  expect(() => sceneOrderChanged(p, ["a", "b", "b"])).toThrow(/repetida na ordem: b/);
  expect(() => sceneOrderChanged(p, ["a", "b"])).toThrow(/sem a cena c/);
  expect(() => sceneOrderChanged(p, [])).toThrow(/sem a cena a/);
});

it("parseEditAction(reorder-scenes): exige lista não vazia de ids", () => {
  expect(parseEditAction({ type: "reorder-scenes", order: ["a", "b"] })).toEqual({ type: "reorder-scenes", order: ["a", "b"] });
  expect(() => parseEditAction({ type: "reorder-scenes", order: [] })).toThrow();
  expect(() => parseEditAction({ type: "reorder-scenes", order: "a,b" })).toThrow();
  expect(() => parseEditAction({ type: "reorder-scenes" })).toThrow();
  expect(() => parseEditAction({ type: "reorder-scenes", order: ["a", 2] })).toThrow();
  expect(() => parseEditAction({ type: "reorder-scenes", order: ["a", ""] })).toThrow();
});

it("o rótulo do passo é \"Mover cena\"", () => {
  expect(editLabel({ type: "reorder-scenes", order: ["a"] })).toBe("Mover cena");
});

it("applyTextEdit(reorder-scenes): reordena de uma vez; a mesma ordem lança", () => {
  const p = projeto(["a", "b", "c", "d"]);
  const novo = applyTextEdit(p, { type: "reorder-scenes", order: ["d", "a", "b", "c"] });
  expect(novo.scenes.map((s) => s.id)).toEqual(["d", "a", "b", "c"]);
  expect(p.scenes.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  expect(() => applyTextEdit(p, { type: "reorder-scenes", order: ["a", "b", "c", "d"] })).toThrow(/não mudou/);
});
