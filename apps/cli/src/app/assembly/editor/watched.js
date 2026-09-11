// Estado "assistido de verdade" (Task 9): pura e testável. O front só
// considera assistida a prévia da revisão atual vista até o fim; qualquer
// outro caso bloqueia o approveFinal (o back-end rejeita de todo jeito).
export function watchedState(project, watched) {
  const revision = project ? project.revision : null;
  const previewRevision = project ? project.previewRevision : null;
  const watchedRevision = watched ? watched.revision : null;
  const ended = watched ? watched.ended === true : false;
  if (previewRevision == null) {
    return { fresh: false, watched: false, canApprove: false, label: "renderizando…" };
  }
  const fresh = previewRevision === revision;
  if (!fresh) {
    return { fresh, watched: false, canApprove: false, label: "desatualizada — atualizar" };
  }
  const watchedOk = ended && watchedRevision === previewRevision;
  if (watchedOk) {
    return { fresh, watched: true, canApprove: true, label: "assistida ✓" };
  }
  return { fresh, watched: false, canApprove: false, label: "prévia atualizada ✓" };
}
