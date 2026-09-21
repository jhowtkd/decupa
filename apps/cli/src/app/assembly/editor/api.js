// Cliente HTTP mínimo do editor texto-centrado (Task 4). Sem DOM:
// o estado de carregamento sai via `onStatus({busy, label?, error?})`
// injetado pela página. Mantém o espírito de trackStart/trackEnd do
// page.js (contagem de em-voo + rótulo + erro por resposta).
export function createApi({ onStatus } = {}) {
  let inflight = 0;
  let label = null;

  function emit(patch = {}) {
    if (typeof onStatus === "function") {
      onStatus({ busy: inflight > 0, label, error: null, ...patch });
    }
  }

  async function call(path, opts = {}) {
    const { label: callLabel, ...fetchOpts } = opts;
    const tracked = callLabel != null;
    if (tracked) {
      inflight += 1;
      label = callLabel;
      emit({ error: null });
    }
    try {
      const res = await fetch(path, {
        ...fetchOpts,
        headers: { "content-type": "application/json", ...fetchOpts.headers },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) emit({ error: body.error || "erro " + res.status });
      return { res, body };
    } catch (err) {
      emit({ error: (err && err.message) || String(err) });
      throw err;
    } finally {
      if (tracked) {
        inflight = Math.max(0, inflight - 1);
        if (inflight === 0) label = null;
        emit({});
      }
    }
  }

  return { call };
}

/** Um timer e uma consulta em voo, inclusive se refresh notificar o estado. */
export function createProjectPoller({ refresh, isBusy, interval = 1000 }) {
  let timer = null;
  let inflight = false;
  function schedule() {
    if (timer !== null || inflight || !isBusy()) return;
    timer = setTimeout(async () => {
      timer = null;
      inflight = true;
      try {
        await refresh();
      } catch {
        // O cliente já apresenta o erro; a consulta seguinte tenta reconectar.
      } finally {
        inflight = false;
        schedule();
      }
    }, interval);
  }
  return { schedule };
}
