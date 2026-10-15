import { projectHeaders, projectPath, projectTabId } from "./project-path.js";

function reservationAge(ultimoSinal) {
  return Math.max(0, Math.floor((Date.now() - ultimoSinal) / 1000));
}

function localTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
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
export function mountEditReservationUI({ onReadOnly = () => {}, onTakeover = () => {} } = {}) {
  const reservationElement = document.getElementById("editReservation");
  const reservationText = document.getElementById("editReservationText");
  const reservationTake = document.getElementById("reservationTake");
  const originalDisabled = new WeakMap();
  let currentOwner = null;

  function paintReadOnly() {
    document.body.classList.toggle("modo-leitura", Boolean(currentOwner));
    for (const element of document.querySelectorAll("button, input, textarea, select")) {
      if (element === reservationTake || element.matches("[data-stage], #monitorToggle, #closeMonitor")) continue;
      if (currentOwner) {
        if (!originalDisabled.has(element)) originalDisabled.set(element, element.disabled);
        element.disabled = true;
      } else if (originalDisabled.has(element)) {
        element.disabled = originalDisabled.get(element);
        originalDisabled.delete(element);
      }
    }
  }

  function setReadOnly(owner) {
    currentOwner = owner;
    onReadOnly(owner);
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
    const response = await fetch(projectPath("reservation"), {
      method: "POST", headers: projectHeaders({ "content-type": "application/json" }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409) handleConflict(body);
    else if (response.ok) setReadOnly(null);
  }

  async function heartbeat() {
    try {
      const response = await fetch(projectPath("reservation/heartbeat"), {
        method: "POST", headers: projectHeaders({ "content-type": "application/json" }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409) handleConflict(body);
      else if (response.ok) setReadOnly(null);
    } catch {
      // O próximo sinal tenta renovar ou revela que outra aba assumiu.
    }
  }

  const reservationTimer = setInterval(() => { void heartbeat(); }, 20_000);
  window.addEventListener("pagehide", () => {
    clearInterval(reservationTimer);
    const body = JSON.stringify({ tabId: projectTabId() });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(projectPath("reservation/release"), new Blob([body], { type: "application/json" }));
    } else {
      void fetch(projectPath("reservation/release"), {
        method: "POST", headers: projectHeaders({ "content-type": "application/json" }), body, keepalive: true,
      });
    }
  });

  reservationTake?.addEventListener("click", async () => {
    if (!currentOwner || !(await confirmEditTakeover(currentOwner))) return;
    const response = await fetch(projectPath("reservation/take"), {
      method: "POST", headers: projectHeaders({ "content-type": "application/json" }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setReadOnly(null);
      await onTakeover();
    } else if (response.status === 409) handleConflict(body);
  });

  const observer = new MutationObserver(() => { if (currentOwner) paintReadOnly(); });
  observer.observe(document.body, { childList: true, subtree: true });
  void acquire().catch(() => {});

  return {
    handleConflict,
    isReadOnly: () => Boolean(currentOwner),
    setReadOnly,
  };
}
