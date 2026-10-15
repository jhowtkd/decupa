import { expect, it } from "vitest";
import { createReservationLifecycle, mountEditReservationUI, paintReadOnlyControls } from "./edit-reservation-ui.js";

function control({ disabled = false, dialog = false }: { disabled?: boolean; dialog?: boolean } = {}) {
  return {
    disabled,
    matches: (selector: string) => selector.includes("#monitorToggle") && false,
    closest: (selector: string) => selector === "[data-edit-reservation-dialog]" && dialog ? {} : null,
  };
}

it("pintura do Modo Leitura não desabilita os botões do diálogo de tomada", () => {
  const cancel = control({ dialog: true });
  const take = control({ dialog: true });
  const normal = control({ disabled: true });
  const body = { classList: { toggle() {} } };
  const root = { body, querySelectorAll: () => [cancel, take, normal] };
  const originalDisabled = new WeakMap();

  paintReadOnlyControls(root, { nome: "outra pessoa" }, null, originalDisabled);

  expect(cancel.disabled).toBe(false);
  expect(take.disabled).toBe(false);
  expect(normal.disabled).toBe(true);
});

it("reativa a Reserva depois de pagehide/pageShow persistido", async () => {
  let acquired = 0;
  let released = 0;
  let heartbeats = 0;
  let nextTimer = 0;
  const timers = new Set<number>();
  const lifecycle = createReservationLifecycle({
    acquire: async () => { acquired += 1; },
    release: async () => { released += 1; },
    heartbeat: async () => { heartbeats += 1; },
    setIntervalFn: (fn: () => void) => { void fn; const timer = ++nextTimer; timers.add(timer); return timer; },
    clearIntervalFn: (timer: unknown) => { timers.delete(timer as number); },
  });

  await lifecycle.resume();
  expect(acquired).toBe(1);
  expect(timers.size).toBe(1);
  lifecycle.pagehide();
  expect(released).toBe(1);
  expect(timers.size).toBe(0);
  await lifecycle.pageshow({ persisted: true });
  expect(acquired).toBe(2);
  expect(timers.size).toBe(1);
  expect(heartbeats).toBe(0);
});

it("bloqueia a edição enquanto reacquire após troca tardia do id da aba", async () => {
  const globals = globalThis as unknown as {
    document?: unknown;
    window?: unknown;
    MutationObserver?: unknown;
    fetch?: unknown;
  };
  const previous = {
    document: globals.document,
    window: globals.window,
    MutationObserver: globals.MutationObserver,
    fetch: globals.fetch,
  };
  let acquired = 0;
  let readOnly = false;
  let tabChanged: (() => void) | undefined;
  const body = { classList: { toggle() {} } };
  globals.document = {
    body,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  globals.window = { addEventListener() {} };
  globals.MutationObserver = class {
    observe() {}
  };
  globals.fetch = async () => {
    acquired += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    mountEditReservationUI({
      onReadOnly: (owner) => { readOnly = Boolean(owner); },
      tabIdentity: {
        ready: () => Promise.resolve(),
        onChange: (listener) => { tabChanged = listener; },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acquired).toBe(1);

    tabChanged?.();
    expect(readOnly).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acquired).toBe(2);
    expect(readOnly).toBe(false);
  } finally {
    if (previous.document === undefined) delete globals.document;
    else globals.document = previous.document;
    if (previous.window === undefined) delete globals.window;
    else globals.window = previous.window;
    if (previous.MutationObserver === undefined) delete globals.MutationObserver;
    else globals.MutationObserver = previous.MutationObserver;
    if (previous.fetch === undefined) delete globals.fetch;
    else globals.fetch = previous.fetch;
  }
});
