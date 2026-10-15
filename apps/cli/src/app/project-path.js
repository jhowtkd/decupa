/** Monta um caminho pertencente ao Projeto a partir do prefixo injetado pelo servidor. */
export function projectPath(path) {
  const prefix = typeof document === "undefined"
    ? ""
    : document.querySelector('meta[name="decupa-project-prefix"]')?.getAttribute("content") || "";
  const clean = String(path).replace(/^\/+/, "");
  return `${prefix}/${clean}`.replace(/\/$/, path.endsWith("/") ? "/" : "");
}

const TAB_KEY = "decupa-tab-id";

/** Uma aba mantém a mesma identidade mesmo quando a página é recarregada. */
export function projectTabId() {
  try {
    const existing = sessionStorage.getItem(TAB_KEY);
    if (existing) return existing;
    const generated = globalThis.crypto?.randomUUID?.()
      || `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(TAB_KEY, generated);
    return generated;
  } catch {
    // Ambientes sem sessionStorage continuam funcionando; a aba perde a
    // retomada silenciosa, mas nunca deixa de enviar uma identidade.
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function projectHeaders(headers = {}) {
  return { "x-decupa-tab": projectTabId(), ...headers };
}

/** Confirma a tomada da Reserva mostrando a idade do último sinal. */
export function confirmEditTakeover(owner) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "max-width: min(32rem, calc(100vw - 2rem)); padding: 1.25rem; border: 1px solid #303238; border-radius: 12px; background: #191a1d; color: #f0f0ed";
    const age = Math.max(0, Math.floor((Date.now() - owner.ultimoSinal) / 1000));
    const recent = age < 30;
    const title = document.createElement("h2");
    title.textContent = "Assumir Edição?";
    const message = document.createElement("p");
    message.textContent = `${owner.nome} está editando este Projeto há ${age} s.`;
    const warning = document.createElement("p");
    warning.textContent = recent
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
    const finish = (value) => {
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
