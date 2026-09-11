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
