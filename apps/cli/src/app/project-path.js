/** Monta um caminho pertencente ao Projeto a partir do prefixo injetado pelo servidor. */
export function projectPath(path) {
  const prefix = typeof document === "undefined"
    ? ""
    : document.querySelector('meta[name="decupa-project-prefix"]')?.getAttribute("content") || "";
  const clean = String(path).replace(/^\/+/, "");
  return `${prefix}/${clean}`.replace(/\/$/, path.endsWith("/") ? "/" : "");
}

const TAB_KEY = "decupa-tab-id";

/** @returns {string} */
function newTabId() {
  return globalThis.crypto?.randomUUID?.()
    || `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * sessionStorage é copiado por "Duplicar aba". O BroadcastChannel dá uma
 * janela para a cópia perceber que já há uma página viva com o mesmo id e
 * trocar somente a sua identidade; recarregar a página, por outro lado,
 * conserva o id para retomar a Reserva.
 */
/**
 * @param {{ storage?: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }, channel?: { addEventListener: Function, postMessage: Function }, idFactory?: () => string }} options
 */
export function createTabIdentity({ storage, channel, idFactory = newTabId } = {}) {
  let id;
  try {
    id = storage?.getItem(TAB_KEY) || idFactory();
    storage?.setItem(TAB_KEY, id);
  } catch {
    id = idFactory();
  }
  const nonce = idFactory();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  if (channel?.addEventListener) {
    channel.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "decupa-tab-hello" && message.nonce !== nonce && message.id === id) {
        channel.postMessage({ type: "decupa-tab-conflict", id, target: message.nonce });
      } else if (message?.type === "decupa-tab-conflict" && message.target === nonce && message.id === id) {
        id = idFactory();
        try { storage?.setItem(TAB_KEY, id); } catch { /* sessão indisponível */ }
      }
    });
    channel.postMessage({ type: "decupa-tab-hello", id, nonce });
    // BroadcastChannel entrega mensagens em outra tarefa no navegador.
    setTimeout(resolveReady, 0);
  } else {
    resolveReady();
  }
  return { get: () => id, ready };
}

function browserStorage() {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

const tabStorage = browserStorage();
const tabChannel = tabStorage && typeof globalThis.BroadcastChannel === "function"
  ? new globalThis.BroadcastChannel("decupa-tab-id") : undefined;
const tabIdentity = createTabIdentity({ storage: tabStorage, channel: tabChannel });

export function projectTabId() { return tabIdentity.get(); }

export function projectTabReady() { return tabIdentity.ready; }

export function projectHeaders(headers = {}) {
  return { "x-decupa-tab": projectTabId(), ...headers };
}
