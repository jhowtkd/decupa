import type { EditAction, Project, UndoStack, UndoStep } from "./types.ts";

/** Passos guardados na pilha do desfazer; o mais antigo sai primeiro. */
export const UNDO_LIMIT = 20;

const EDIT_LABEL: Record<EditAction["type"], string> = {
  remove: "Tirar trecho",
  restore: "Restaurar trecho",
  protect: "Preservar trecho",
  unprotect: "Liberar trecho",
  include: "Incluir trecho",
  correct: "Corrigir texto",
  "move-scene": "Mover cena",
  "delete-scene": "Apagar cena",
  "set-support": "Alterar apoio",
};

/** O que o botão de desfazer anuncia para uma edição pelo texto. */
export function editLabel(action: EditAction): string {
  return EDIT_LABEL[action.type];
}

/** Passos da pilha que ainda valem para o projeto; pilha quebrada não tem passo. */
function liveSteps(project: Project): UndoStep[] {
  const undo = project.undo;
  return undo && undo.head === project.revision ? undo.steps : [];
}

/** Passo que o próximo desfazer restaura, ou null. */
export function undoTop(project: Project): UndoStep | null {
  return liveSteps(project).at(-1) ?? null;
}

/**
 * Registra a transição `before` → `after` como um passo: a foto de `before`
 * já foi gravada em `history/rev-<before.revision>.json`. Uma mudança de
 * revisão sem foto no meio quebrou a pilha, então ela recomeça.
 */
export function recordUndo(before: Project, after: Project, label: string): Project {
  const steps = [...liveSteps(before), { revision: before.revision, label }].slice(-UNDO_LIMIT);
  return { ...after, undo: { head: after.revision, steps } };
}

/**
 * Tira o passo desfeito da pilha. O estado de antes do desfazer não vira
 * passo: o desfazer seguinte volta mais um, nunca refaz.
 */
export function popUndo(before: Project, after: Project): Project {
  return { ...after, undo: { head: after.revision, steps: liveSteps(before).slice(0, -1) } };
}

/**
 * Pilha gravada; formato inválido vira "sem desfazer" em vez de projeto
 * ilegível. Cada passo é uma foto de revisão anterior ao `head`, e as
 * revisões crescem de passo em passo (é assim que `recordUndo` as grava).
 */
export function readUndoStack(value: unknown): UndoStack | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { head, steps } = value as { head?: unknown; steps?: unknown };
  if (!Number.isSafeInteger(head) || (head as number) < 0 || !Array.isArray(steps)) return undefined;
  let previous = -1;
  const valid = steps.every((step: unknown) => {
    if (typeof step !== "object" || step === null) return false;
    const { revision, label } = step as { revision?: unknown; label?: unknown };
    if (!Number.isSafeInteger(revision) || typeof label !== "string") return false;
    const n = revision as number;
    if (n <= previous || n >= (head as number)) return false;
    previous = n;
    return true;
  });
  if (!valid) return undefined;
  return {
    head: head as number,
    steps: (steps as UndoStep[]).slice(-UNDO_LIMIT).map(({ revision, label }) => ({ revision, label })),
  };
}
