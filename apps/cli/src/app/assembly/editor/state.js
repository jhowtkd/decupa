// Store mínimo do editor texto-centrado (Task 4).
// Chaves canônicas (a UI toda usa estas): "project", "operation",
// "selection" (Set de `sceneId\0takeId\0wordId`), "playhead" (segundos
// na montagem ou null), "watched" (`{revision, ended}`).
export function createState(initial = {}) {
  const values = { ...initial };
  const listeners = new Map();
  return {
    get(key) {
      return values[key];
    },
    set(key, value) {
      values[key] = value;
      const subs = listeners.get(key);
      if (subs) for (const fn of [...subs]) fn(value);
    },
    subscribe(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
  };
}
