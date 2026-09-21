import { expect, it } from "vitest";
import { createState } from "./state.js";

it("set notifica só a chave inscrita", () => {
  const s = createState({ project: null });
  const seen: unknown[] = [];
  s.subscribe("project", (p: unknown) => seen.push(p));
  s.subscribe("operation", () => seen.push("nunca"));
  s.set("project", { revision: 1 });
  expect(seen).toEqual([{ revision: 1 }]);
  expect(s.get("project")).toEqual({ revision: 1 });
});

it("revisão nova reseta watched; mesma revisão preserva", () => {
  const s = createState({ project: { revision: 1 }, watched: { revision: 1, ended: true } });
  const seen: unknown[] = [];
  s.subscribe("watched", (w: unknown) => seen.push(w));
  s.set("project", { revision: 1, previewRevision: 1 });
  expect(s.get("watched")).toEqual({ revision: 1, ended: true });
  expect(seen).toEqual([]);
  s.set("project", { revision: 2, previewRevision: 1 });
  expect(s.get("watched")).toEqual({ revision: null, ended: false });
  expect(seen).toEqual([{ revision: null, ended: false }]);
});

it("ignora snapshots idênticos mas publica progresso na mesma revisão", () => {
  const s = createState();
  const seen: unknown[] = [];
  s.subscribe("project", (p: unknown) => seen.push(p));
  s.set("project", { revision: 2, preparation: { stage: "audio" } });
  s.set("project", { revision: 2, preparation: { stage: "audio" } });
  s.set("project", { revision: 2, preparation: { stage: "visual" } });
  expect(seen).toHaveLength(2);
});
