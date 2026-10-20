/** Pergunta feita antes de preparar por cima de cenas que mudaram. */
export const PREPARE_CONFIRM = "Preparar de novo substitui as cenas atuais, inclusive o que você editou à mão. "
  + "Dá para voltar com Desfazer. Continuar?";

/**
 * Montar/Preparar/Retomar trocam as cenas (puro): pede confirmação quando já
 * há cenas e o projeto mudou desde a última preparação que as aplicou
 * (`preparedRevision`). Projeto antigo, sem o registro, também pergunta.
 */
export function prepareNeedsConfirm(project) {
  return !!project && project.scenes.length > 0 && project.revision !== project.preparedRevision;
}
