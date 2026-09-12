import { expect, it } from "vitest";
import { menuActionsFor, sceneHeaderActions } from "./texto.js";

type Sel = { removed?: boolean; protected?: boolean; takeId?: string };

const mantida = (over: Sel = {}): Sel => ({ removed: false, protected: false, takeId: "t1", ...over });

function actionsOf(sel: Sel[]): string[] {
  return menuActionsFor(sel).map((item: { action: string }) => item.action);
}

it("seleção mantida oferece a base ouvir/tirar/preservar/corrigir", () => {
  expect(actionsOf([mantida(), mantida()])).toEqual(["ouvir", "tirar", "preservar", "corrigir"]);
});

it("seleção toda removida troca tirar por restaurar", () => {
  expect(actionsOf([mantida({ removed: true }), mantida({ removed: true })]))
    .toEqual(["ouvir", "restaurar", "preservar", "corrigir"]);
});

it("seleção toda protegida troca preservar por liberar", () => {
  expect(actionsOf([mantida({ protected: true }), mantida({ protected: true })]))
    .toEqual(["ouvir", "tirar", "liberar", "corrigir"]);
});

it("seleção mista mantida+removida não oferece tirar (ambíguo: documentado)", () => {
  // Tirar cortaria só metade e restaurar devolveria a outra: o menu omite
  // tirar na mistura em vez de adivinhar a intenção.
  expect(actionsOf([mantida(), mantida({ removed: true })]))
    .toEqual(["ouvir", "preservar", "corrigir"]);
});

it("seleção em zona omitida (takeId vazio) vira ouvir/incluir", () => {
  expect(actionsOf([
    { removed: false, protected: false, takeId: "" },
    { removed: false, protected: false, takeId: "" },
  ])).toEqual(["ouvir", "incluir"]);
});

it("seleção vazia não abre menu", () => {
  expect(menuActionsFor([])).toEqual([]);
});

it("rótulos em pt-BR e tirar marcado como perigoso", () => {
  for (const item of menuActionsFor([mantida()])) {
    expect(item.label.trim().length).toBeGreaterThan(0);
  }
  const tirar = menuActionsFor([mantida()]).find((item: { action: string }) => item.action === "tirar");
  expect(tirar?.danger).toBe(true);
  const ouvir = menuActionsFor([mantida()]).find((item: { action: string }) => item.action === "ouvir");
  expect(ouvir?.danger ?? false).toBe(false);
});

it("sceneHeaderActions desabilita os extremos e sempre oferece excluir", () => {
  const first = sceneHeaderActions(0, 3);
  expect(first.find((a: { direction?: string }) => a.direction === "up")?.disabled).toBe(true);
  expect(first.find((a: { direction?: string }) => a.direction === "down")?.disabled).toBe(false);
  const last = sceneHeaderActions(2, 3);
  expect(last.find((a: { direction?: string }) => a.direction === "down")?.disabled).toBe(true);
  expect(last.find((a: { direction?: string }) => a.direction === "up")?.disabled).toBe(false);
  const mid = sceneHeaderActions(1, 3);
  expect(mid.every((a: { kind?: string; disabled?: boolean }) => a.kind !== "move" || a.disabled === false)).toBe(true);
  const single = sceneHeaderActions(0, 1);
  expect(single.filter((a: { kind?: string }) => a.kind === "move").every((a: { disabled?: boolean }) => a.disabled)).toBe(true);
  for (const header of [first, last, mid, single]) {
    const del = header.find((a: { kind?: string }) => a.kind === "delete");
    expect(del?.disabled).toBe(false);
  }
});
