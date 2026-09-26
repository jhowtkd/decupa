// Aprovação da prévia (pura, só exibição): quanto da prévia atual foi visto
// e o que o cartão de revisão diz. O gate de verdade continua em
// watchedState (watched.js) e no servidor.
import { clock } from "./format.js";

/** Teto do anel enquanto o gate não libera: 100% só com status.watched. */
const UNWATCHED_MAX = 0.99;

export function watchProgress(until, duration, watched) {
  if (watched) return { ratio: 1, label: "vista até o fim" };
  if (!Number.isFinite(duration) || !(duration > 0)) return { ratio: 0, label: "" };
  const at = Math.min(Math.max(Number.isFinite(until) ? until : 0, 0), duration);
  const ratio = Math.min(at / duration, UNWATCHED_MAX);
  // "1:13 de 1:13" leria como vista inteira: sem o gate, falta o final.
  if (clock(at) === clock(duration)) return { ratio, label: "falta assistir ao final" };
  return { ratio, label: "vista até " + clock(at) + " de " + clock(duration) };
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
    visible: true, title: "Assista até o fim para aprovar",
    detail: "Prévia " + v + (progress.label ? " · " + progress.label : "") + " · voltar reinicia a contagem",
    ratio: progress.ratio,
  };
}
