// Topo da bancada (puro): estado das etapas e status sem operação em voo.
export const STAGES = [
  { id: "materiais", label: "Materiais" },
  { id: "edicao", label: "Edição" },
  { id: "revisao", label: "Revisão" },
  { id: "entrega", label: "Entrega" },
];

function approvedNow(project) {
  return project != null && project.finalApprovedRevision != null
    && project.finalApprovedRevision === project.revision;
}

/**
 * Feito/atual/travado derivados do projeto. Materiais conta como feito com
 * fonte incluída; edição e revisão, com a versão atual aprovada; a entrega
 * fica travada até essa aprovação (o servidor também recusa exportar).
 */
export function stepperState(project, current) {
  const included = (project?.assembly?.sources ?? []).some((source) => source.included);
  const approved = approvedNow(project);
  const done = { materiais: included, edicao: approved, revisao: approved, entrega: false };
  return STAGES.map((stage) => ({
    ...stage,
    current: stage.id === current,
    done: stage.id !== current && done[stage.id],
    locked: stage.id === "entrega" && !approved,
  }));
}

export function versionLabel(project) {
  return project ? "v" + project.revision : "";
}

function hasMaterial(project) {
  return (project?.assembly?.sources ?? []).length > 0;
}

/** Pílula de versão ao lado do projeto: só aparece depois do primeiro material. */
export function versionPill(project) {
  return hasMaterial(project) ? { hidden: false, text: versionLabel(project) } : { hidden: true, text: "" };
}

/** Status ocioso: sem material > aprovada > prévia pronta > só a versão. */
export function idleStatus(project) {
  if (!project) return { text: "carregando…", tone: "" };
  if (!hasMaterial(project)) return { text: "Importe um material para montar", tone: "" };
  const v = versionLabel(project);
  if (approvedNow(project)) return { text: v + " aprovada", tone: "ok" };
  if (project.previewRevision != null && project.previewRevision === project.revision) {
    return { text: "Prévia " + v + " pronta", tone: "ok" };
  }
  return { text: v, tone: "" };
}
