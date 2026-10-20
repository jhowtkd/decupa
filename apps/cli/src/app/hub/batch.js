const routes = { resume: "prepare", cancel: "cancel", export: "export" };

/** @template T
 * @param {T[]} projects
 * @returns {T[]}
 */
export function eligibleProjects(projects, selected, action) {
  return projects.filter(project => selected.has(project.id) && project.atividade?.actions?.[action] === true);
}

/** O snapshot orienta a seleção; revisão, reserva e permissões continuam na rota.
 * @param {object} project
 * @param {string} action
 * @param {(url: string, init: object) => Promise<{ok: boolean, json(): Promise<any>}>} fetchImpl
 */
export async function runProjectAction(project, action, fetchImpl = fetch) {
  if (!Object.hasOwn(routes, action) || !project.atividade?.actions?.[action]) throw new Error("Projeto não elegível para esta ação.");
  const cleanup = project.fluxo === "limpeza";
  if (cleanup && (action === "resume" || !project.atividade.jobId)) throw new Error("Projeto não elegível para esta ação.");
  const prefix = `/projects/${encodeURIComponent(project.id)}`;
  const url = cleanup ? `${prefix}/jobs/${encodeURIComponent(project.atividade.jobId)}/${action}` : `${prefix}/project/${routes[action]}`;
  const payload = cleanup ? action === "export" ? { kind: project.atividade.exportKind ?? "mp4" } : {} : { baseRevision: project.atividade.revision };
  const response = await fetchImpl(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Não foi possível aplicar a ação.");
  if (action === "cancel" && (cleanup ? body.ok !== true : body.operation?.stage !== "cancelled")) throw new Error("Não foi possível confirmar o cancelamento da operação.");
  return body;
}
