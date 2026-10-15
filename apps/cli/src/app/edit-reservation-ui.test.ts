import { expect, it } from "vitest";
import { createReservationLifecycle, paintReadOnlyControls } from "./edit-reservation-ui.js";

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
