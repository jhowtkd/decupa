/** Monta uma URL emitida pelo servidor que pertence ao Projeto. */
export function projectUrl(path: string, prefix = ""): string {
  const clean = path.replace(/^\/+/, "");
  return `${prefix}/${clean}`;
}
