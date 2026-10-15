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
