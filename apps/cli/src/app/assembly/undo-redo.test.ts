import { expect, it } from "vitest";
import type { Project } from "./types.ts";
import { popRedo, popUndo, readUndoStack, recordUndo, redoTop, undoTop } from "./undo.ts";

const projeto = (revision: number, undo?: Project["undo"]) => ({ revision, ...(undo ? { undo } : {}) }) as Project;
const passo = (revision: number, label: string) => ({ revision, label });

it("recordUndo grava a pilha sem redo e encerra o ramo", () => {
  const antes = projeto(5, { head: 5, steps: [passo(2, "a")], redo: [passo(3, "x")] });
  const depois = recordUndo(antes, projeto(6), "b");
  expect(depois.undo).toEqual({ head: 6, steps: [passo(2, "a"), passo(5, "b")] });
});

it("popUndo move o topo para o ramo com a revisão desfeita; popRedo devolve", () => {
  const antes = projeto(6, { head: 6, steps: [passo(2, "a"), passo(5, "b")] });
  const desfeito = popUndo(antes, projeto(7));
  expect(desfeito.undo).toEqual({ head: 7, steps: [passo(2, "a")], redo: [passo(6, "b")] });
  expect([undoTop(desfeito), redoTop(desfeito)]).toEqual([passo(2, "a"), passo(6, "b")]);
  const refeito = popRedo(desfeito, projeto(8));
  expect(refeito.undo).toEqual({ head: 8, steps: [passo(2, "a"), passo(7, "b")] });
  expect(redoTop(refeito)).toBeNull();
});

it("popUndo acumula o ramo com o próximo a refazer por último", () => {
  const p0 = projeto(6, { head: 6, steps: [passo(2, "a"), passo(5, "b")] });
  const p1 = popUndo(p0, projeto(7));
  const p2 = popUndo(p1, projeto(8));
  expect(p2.undo).toEqual({ head: 8, steps: [], redo: [passo(6, "b"), passo(7, "a")] });
});

it("o ramo só vale com head igual à revisão atual", () => {
  const velho = projeto(9, { head: 8, steps: [passo(2, "a")], redo: [passo(5, "b")] });
  expect([undoTop(velho), redoTop(velho)]).toEqual([null, null]);
});

it("o ramo e a pilha guardam no máximo 20 passos", () => {
  const steps = Array.from({ length: 20 }, (_, i) => passo(i + 1, `p${i}`));
  const cheia = projeto(30, { head: 30, steps });
  expect(recordUndo(cheia, projeto(31), "novo").undo!.steps).toHaveLength(20);
  const ramo = Array.from({ length: 20 }, (_, i) => passo(i + 1, `r${i}`));
  const comRamo = projeto(30, { head: 30, steps: [passo(25, "z")], redo: ramo });
  expect(popUndo(comRamo, projeto(31)).undo!.redo).toHaveLength(20);
  const pilhaCheia = projeto(30, { head: 30, steps, redo: [passo(25, "z")] });
  expect(popRedo(pilhaCheia, projeto(31)).undo!.steps).toHaveLength(20);
});

it("readUndoStack descarta só o ramo inválido e normaliza campos extras", () => {
  expect(readUndoStack({ head: 5, steps: [{ revision: 2, label: "a", x: 1 }], redo: [{ revision: 9, label: "b" }] }))
    .toEqual({ head: 5, steps: [passo(2, "a")] });
  expect(readUndoStack({ head: 5, steps: [passo(2, "a")], redo: [passo(3, "b")] }))
    .toEqual({ head: 5, steps: [passo(2, "a")], redo: [passo(3, "b")] });
  expect(readUndoStack({ head: 5, steps: "x", redo: [passo(3, "b")] })).toBeUndefined();
});
