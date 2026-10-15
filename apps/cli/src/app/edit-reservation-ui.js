import { projectHeaders, projectPath, projectTabChanges, projectTabId, projectTabReady } from "./project-path.js";

function reservationAge(ultimoSinal) {
  return Math.max(0, Math.floor((Date.now() - ultimoSinal) / 1000));
}

function localTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function paintReadOnlyControls(root, currentOwner, reservationTake, originalDisabled) {
  root.body.classList.toggle("modo-leitura", Boolean(currentOwner));
  for (const element of root.querySelectorAll("button, input, textarea, select")) {
    if (element === reservationTake
      || element.matches("[data-stage], #monitorToggle, #closeMonitor")
      || element.closest?.("[data-edit-reservation-dialog]")) continue;
    if (currentOwner) {
      if (!originalDisabled.has(element)) originalDisabled.set(element, element.disabled);
      element.disabled = true;
    } else if (originalDisabled.has(element)) {
      element.disabled = originalDisabled.get(element);
      originalDisabled.delete(element);
    }
  }
}

/**
 * @param {{ acquire: () => Promise<unknown>, release: () => unknown, heartbeat: () => unknown, setIntervalFn?: (fn: () => void, ms: number) => unknown, clearIntervalFn?: (timer: unknown) => void }} options
 */
export function createReservationLifecycle({ acquire, release, heartbeat, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer = null;
  function start() {
    if (timer === null) timer = setIntervalFn(() => { void heartbeat(); }, 20_000);
  }
  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }
  async function resume() {
    try { await acquire(); } finally { start(); }
  }
  function pagehide() {
    stop();
    void release();
  }
  async function pageshow(event) {
    if (event?.persisted) await resume();
  }
  return { start, stop, resume, pagehide, pageshow };
}

/** Confirma a tomada da Reserva mostrando a idade e o risco de um sinal recente. */
async function confirmEditTakeover(owner) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "max-width: min(32rem, calc(100vw - 2rem)); padding: 1.25rem; border: 1px solid #303238; border-radius: 12px; background: #191a1d; color: #f0f0ed";
    const age = reservationAge(owner.ultimoSinal);
    const title = document.createElement("h2");
    title.textContent = "Assumir Edição?";
    const message = document.createElement("p");
    message.textContent = `${owner.nome} está editando este Projeto há ${age} s.`;
    const warning = document.createElement("p");
    warning.textContent = age < 30
      ? "O sinal é recente; essa pessoa pode estar trabalhando agora."
      : "O último sinal já tem algum tempo; confirme para continuar.";
    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; justify-content: flex-end; gap: .5rem";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancelar";
    const take = document.createElement("button");
    take.type = "button";
    take.textContent = "Assumir Edição";
    actions.append(cancel, take);
    dialog.setAttribute("data-edit-reservation-dialog", "");
    dialog.append(title, message, warning, actions);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(false));
    take.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}

function ownerFrom(body) {
  return body?.dono ? { ...body.dono, mesmaPessoa: body.mesmaPessoa === true } : null;
}

/** Monta a faixa, a tomada, o sinal e a liberação da Reserva da página. */
/**
 * @param {{ onReadOnly?: (owner: unknown) => void, onTakeover?: () => unknown, tabIdentity?: { ready: () => Promise<unknown>, onChange: (listener: () => void) => unknown } }} options
 */
export function mountEditReservationUI({
  onReadOnly = () => {},
  onTakeover = () => {},
  tabIdentity = { ready: projectTabReady, onChange: projectTabChanges },
} = {}) {
  const reservationElement = document.getElementById("editReservation");
  const reservationText = document.getElementById("editReservationText");
  const reservationTake = document.getElementById("reservationTake");
  const originalDisabled = new WeakMap();
  let currentOwner = null;
  let identityChanging = false;

  const paintReadOnly = () => paintReadOnlyControls(
    document,
    currentOwner || (identityChanging ? {} : null),
    reservationTake,
    originalDisabled,
  );

  const notifyReadOnly = () => onReadOnly(currentOwner || (identityChanging ? { identityChanging: true } : null));

  function setReadOnly(owner, { confirmed = false } = {}) {
    if (confirmed) identityChanging = false;
    currentOwner = owner;
    notifyReadOnly();
    if (reservationElement && reservationText) {
      reservationElement.hidden = !owner;
      if (owner) {
        reservationText.textContent = owner.assumidoEm
          ? `${owner.nome} assumiu a edição às ${localTime(owner.assumidoEm)}`
          : owner.mesmaPessoa
            ? "Você está editando este Projeto em outra aba"
            : `${owner.nome} está editando este Projeto · há ${reservationAge(owner.ultimoSinal)} s`;
      }
    }
    paintReadOnly();
  }

  function handleConflict(body) {
    setReadOnly(ownerFrom(body));
  }

  async function acquire() {
    const requestTabId = projectTabId();
    const response = await fetch(projectPath("reservation"), {
      method: "POST", headers: projectHeaders({ "content-type": "application/json" }),
    });
    const body = await response.json().catch(() => ({}));
    if (requestTabId !== projectTabId()) return false;
    if (response.status === 409) {
      handleConflict(body);
      return false;
    }
    if (response.ok) {
      setReadOnly(null, { confirmed: true });
      return true;
    }
    return false;
  }

  let acquireQueue = Promise.resolve();
  const acquireQueued = () => {
    const next = acquireQueue.then(() => acquire());
    acquireQueue = next.catch(() => {});
    return next;
  };

  async function heartbeat() {
    try {
      const requestTabId = projectTabId();
      const response = await fetch(projectPath("reservation/heartbeat"), {
        method: "POST", headers: projectHeaders({ "content-type": "application/json" }),
      });
      const body = await response.json().catch(() => ({}));
      if (requestTabId !== projectTabId()) return;
      if (response.status === 409) handleConflict(body);
      else if (response.ok) setReadOnly(null, { confirmed: true });
    } catch {
      // O próximo sinal tenta renovar ou revela que outra aba assumiu.
    }
  }

  const releaseReservation = () => {
    const body = JSON.stringify({ tabId: projectTabId() });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(projectPath("reservation/release"), new Blob([body], { type: "application/json" }));
    } else {
      return fetch(projectPath("reservation/release"), {
        method: "POST", headers: projectHeaders({ "content-type": "application/json" }), body, keepalive: true,
      });
    }
  };
  const lifecycle = createReservationLifecycle({ acquire: acquireQueued, release: releaseReservation, heartbeat });
  window.addEventListener("pagehide", lifecycle.pagehide);
  window.addEventListener("pageshow", (event) => { void lifecycle.pageshow(event).catch(() => {}); });

  reservationTake?.addEventListener("click", async () => {
    if (!currentOwner || !(await confirmEditTakeover(currentOwner))) return;
    const requestTabId = projectTabId();
    const response = await fetch(projectPath("reservation/take"), {
      method: "POST", headers: projectHeaders({ "content-type": "application/json" }),
    });
    const body = await response.json().catch(() => ({}));
    if (requestTabId !== projectTabId()) return;
    if (response.ok) {
      setReadOnly(null, { confirmed: true });
      await onTakeover();
    } else if (response.status === 409) handleConflict(body);
  });

  const observer = new MutationObserver(() => { if (currentOwner || identityChanging) paintReadOnly(); });
  observer.observe(document.body, { childList: true, subtree: true });

  let identityChangeGeneration = 0;
  tabIdentity.onChange(() => {
    const generation = ++identityChangeGeneration;
    identityChanging = true;
    notifyReadOnly();
    paintReadOnly();
    // Uma troca tardia identifica esta página como cópia; a nova Reserva só é
    // aceita se o servidor confirmar que ela ainda pode editar.
    void acquireQueued().then((acquired) => {
      if (generation !== identityChangeGeneration) return;
      if (!acquired && !currentOwner) return;
      identityChanging = false;
      notifyReadOnly();
      paintReadOnly();
    }).catch(() => {});
  });
  void tabIdentity.ready().then(() => lifecycle.resume()).catch(() => {});

  return {
    handleConflict,
    isReadOnly: () => Boolean(currentOwner || identityChanging),
    setReadOnly,
  };
}
