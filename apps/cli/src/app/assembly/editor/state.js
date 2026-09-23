// Store mínimo do editor texto-centrado (Task 4).
// Chaves canônicas (a UI toda usa estas): "project", "operation",
// "selection" (Set de `sceneId\0takeId\0wordId`), "playhead" (segundos
// na montagem ou null), "watched" (`{revision, ended}`),
// "stage" (`materiais` | `edicao` | `revisao` | `entrega`),
// "transcriptNotice" (aviso visível quando a transcrição parcial chega).
import { partialTranscriptView } from "./texto.js";

export function createState(initial = {}) {
  const values = { ...initial };
  const listeners = new Map();
  const snapshots = new Map();
  function notify(key, value) {
    const subs = listeners.get(key);
    // oxlint-disable-next-line no-useless-spread -- cópia intencional: um ouvinte pode se remover durante o notify.
    if (subs) for (const fn of [...subs]) fn(value);
  }
  function applyTranscript(stage, previous, next) {
    const view = partialTranscriptView(stage, previous, next);
    const notice = view.transcriptNotice || "";
    if (notice !== (values.transcriptNotice || "")) {
      values.transcriptNotice = notice;
      notify("transcriptNotice", notice);
    }
    if (view.stage !== (values.stage || "materiais")) {
      values.stage = view.stage;
      notify("stage", view.stage);
    }
  }
  return {
    get(key) {
      return values[key];
    },
    set(key, value) {
      // Polls idênticos não recriam mídia, timeline nem campos em edição.
      if (["project", "operation", "undoRevision", "brollCandidates"].includes(key)) {
        const snapshot = JSON.stringify(value);
        if (snapshots.get(key) === snapshot) return;
        snapshots.set(key, snapshot);
      }
      if (key === "project") {
        const prev = values.project;
        const stage = values.stage || "materiais";
        const prevRev = prev ? prev.revision : undefined;
        const nextRev = value ? value.revision : undefined;
        values[key] = value;
        notify(key, value);
        // Edição (revisão nova) invalida o "assistido": é preciso assistir
        // à prévia atual até o fim de novo (Task 9).
        if (prevRev !== nextRev) {
          values.watched = { revision: null, ended: false };
          notify("watched", values.watched);
        }
        applyTranscript(stage, prev, value);
        return;
      }
      if (key === "stage") {
        if (values.stage === value) return;
        values.stage = value;
        notify("stage", value);
        applyTranscript(value, values.project, values.project);
        return;
      }
      values[key] = value;
      notify(key, value);
    },
    subscribe(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
  };
}
