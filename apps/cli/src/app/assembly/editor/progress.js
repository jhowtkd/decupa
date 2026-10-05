// Aprovação da prévia (pura, só exibição): quanto da prévia atual foi tocado
// de fato (a cobertura de playback.js) e o que o cartão de revisão diz. O gate
// de verdade continua em watchedState (watched.js) e no servidor.
import { clock } from "./format.js";

/** Teto do anel enquanto o gate não libera: 100% só com status.watched. */
const UNWATCHED_MAX = 0.99;

/**
 * Anel e texto a partir dos segundos cobertos (não da posição mais distante:
 * um seek para a frente não conta). O trecho coberto pode não começar no zero,
 * então o texto diz quanto foi visto, não "até onde".
 */
export function watchProgress(covered, duration, watched) {
  if (watched) return { ratio: 1, label: "vista até o fim" };
  if (!Number.isFinite(duration) || !(duration > 0)) return { ratio: 0, label: "" };
  const seen = Math.min(Math.max(Number.isFinite(covered) ? covered : 0, 0), duration);
  const ratio = Math.min(seen / duration, UNWATCHED_MAX);
  // "1:13 de 1:13" leria como vista inteira: sem o gate, falta um trecho.
  if (clock(seen) === clock(duration)) return { ratio, label: "falta assistir um trecho" };
  return { ratio, label: clock(seen) + " de " + clock(duration) + " vistos" };
}

export function reviewView(project, status, progress) {
  if (!project || !project.scenes.length) return { visible: false, title: "", detail: "", ratio: 0 };
  if (project.previewRevision == null) {
    return { visible: true, title: "A prévia ainda não está pronta", detail: "Ela aparece aqui quando o render terminar.", ratio: 0 };
  }
  const v = "v" + project.previewRevision;
  if (project.finalApprovedRevision != null && project.finalApprovedRevision === project.revision) {
    return { visible: true, title: "Prévia aprovada", detail: v + " · assistida até o fim", ratio: 1 };
  }
  if (!status.fresh) {
    return { visible: true, title: "Prévia desatualizada", detail: "Prévia " + v + " · a versão atual é v" + project.revision, ratio: 0 };
  }
  if (status.watched) return { visible: true, title: "Pronta para aprovar", detail: "Prévia " + v + " · vista até o fim", ratio: 1 };
  return {
    visible: true, title: "Pronta para aprovar",
    detail: "Prévia " + v + (progress.label ? " · " + progress.label : "") + " · voltar reinicia a contagem",
    ratio: progress.ratio,
  };
}

/**
 * Botão de aprovar (puro). Com a versão atual já aprovada no servidor, diz
 * "Aprovada" sem cadeado (o assistido zera no reload, a aprovação não).
 * Senão segue o gate canApprove de watchedState, e trava no Original.
 */
export function approveButtonView(project, status, original) {
  const approved = project != null && project.finalApprovedRevision != null
    && project.finalApprovedRevision === project.revision;
  if (approved) return { label: "Aprovada", disabled: true, locked: false, icon: "check", approved: true };
  const locked = !status.canApprove || original;
  return { label: "Aprovar prévia", disabled: locked, locked, icon: locked ? "lock" : "check", approved: false };
}
