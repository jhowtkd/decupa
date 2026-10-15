/** Monta um caminho pertencente ao Projeto a partir do prefixo injetado pelo servidor. */
export function projectPath(path) {
  const prefix = typeof document === "undefined"
    ? ""
    : document.querySelector('meta[name="decupa-project-prefix"]')?.getAttribute("content") || "";
  const clean = String(path).replace(/^\/+/, "");
  return `${prefix}/${clean}`.replace(/\/$/, path.endsWith("/") ? "/" : "");
}
