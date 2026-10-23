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
  "reorder-scenes": "Mover cena",
  "delete-scene": "Apagar cena",
  "set-support": "Alterar apoio",
};

/** O que o botão de desfazer anuncia para uma edição pelo texto. */
export function editLabel(action: EditAction): string {
  return EDIT_LABEL[action.type];
}

/** A pilha só vale na revisão em que foi gravada; fora dela não há passo. */
function liveStack(project: Project): UndoStack | null {
  const undo = project.undo;
  return undo && undo.head === project.revision ? undo : null;
}

/** Passos da pilha que ainda valem para o projeto; pilha quebrada não tem passo. */
function liveSteps(project: Project): UndoStep[] {
  return liveStack(project)?.steps ?? [];
}

/** Ramo do refazer que ainda vale: some com a pilha, pela mesma regra. */
function liveRedo(project: Project): UndoStep[] {
  return liveStack(project)?.redo ?? [];
}

/** Pilha nova; o ramo do refazer só é gravado quando tem passo. */
function stack(head: number, steps: UndoStep[], redo: UndoStep[]): UndoStack {
  return redo.length ? { head, steps, redo } : { head, steps };
}

/** Passo que o próximo desfazer restaura, ou null. */
export function undoTop(project: Project): UndoStep | null {
  return liveSteps(project).at(-1) ?? null;
}

/** Passo que o próximo refazer restaura, ou null. */
export function redoTop(project: Project): UndoStep | null {
  return liveRedo(project).at(-1) ?? null;
}

/**
 * Registra a transição `before` → `after` como um passo: a foto de `before`
 * já foi gravada em `history/rev-<before.revision>.json`. Uma mudança de
 * revisão sem foto no meio quebrou a pilha, então ela recomeça. Edição nova
 * encerra o ramo do refazer.
 */
export function recordUndo(before: Project, after: Project, label: string): Project {
  const steps = [...liveSteps(before), { revision: before.revision, label }].slice(-UNDO_LIMIT);
  return { ...after, undo: stack(after.revision, steps, []) };
}

/**
 * Tira o passo desfeito da pilha e o põe no ramo do refazer, apontando para
 * a foto de `before` (o estado desfeito), que o chamador já gravou. O
 * desfazer seguinte volta mais um; o refazer volta o que saiu.
 */
export function popUndo(before: Project, after: Project): Project {
  const steps = liveSteps(before);
  const top = steps.at(-1);
  const redo = top ? [...liveRedo(before), { revision: before.revision, label: top.label }] : liveRedo(before);
  return { ...after, undo: stack(after.revision, steps.slice(0, -1), redo.slice(-UNDO_LIMIT)) };
}

/**
 * Espelho do `popUndo`: tira o passo refeito do ramo e o devolve à pilha do
 * desfazer, apontando para a foto de `before`, que o chamador já gravou.
 */
export function popRedo(before: Project, after: Project): Project {
  const redo = liveRedo(before);
  const top = redo.at(-1);
  const steps = top ? [...liveSteps(before), { revision: before.revision, label: top.label }] : liveSteps(before);
  return { ...after, undo: stack(after.revision, steps.slice(-UNDO_LIMIT), redo.slice(0, -1)) };
}

/**
 * Passos gravados: cada um é uma foto de revisão anterior ao `head`, e as
 * revisões crescem de passo em passo (é assim que as funções acima gravam).
 */
function readSteps(value: unknown, head: number): UndoStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let previous = -1;
  const valid = value.every((step: unknown) => {
    if (typeof step !== "object" || step === null) return false;
    const { revision, label } = step as { revision?: unknown; label?: unknown };
    if (!Number.isSafeInteger(revision) || typeof label !== "string") return false;
    const n = revision as number;
    if (n <= previous || n >= head) return false;
    previous = n;
    return true;
  });
  if (!valid) return undefined;
  return (value as UndoStep[]).slice(-UNDO_LIMIT).map(({ revision, label }) => ({ revision, label }));
}

/**
 * Pilha gravada; formato inválido vira "sem desfazer" em vez de projeto
 * ilegível. Ramo do refazer inválido vira só "sem refazer", e também o que
 * nenhuma gravação produz: revisão nas duas listas ou mais de 20 passos
 * somados (desfazer e refazer só trocam passos entre elas).
 */
export function readUndoStack(value: unknown): UndoStack | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { head, steps, redo } = value as { head?: unknown; steps?: unknown; redo?: unknown };
  if (!Number.isSafeInteger(head) || (head as number) < 0) return undefined;
  const undoSteps = readSteps(steps, head as number);
  if (!undoSteps) return undefined;
  const redoSteps = readSteps(redo, head as number) ?? [];
  const inUndo = new Set(undoSteps.map((step) => step.revision));
  const coherent = undoSteps.length + redoSteps.length <= UNDO_LIMIT
    && redoSteps.every((step) => !inUndo.has(step.revision));
  return stack(head as number, undoSteps, coherent ? redoSteps : []);
}
