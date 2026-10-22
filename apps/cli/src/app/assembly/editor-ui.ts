/** Shell da Montagem que o servidor entrega: `legacy` (bancada atual) ou `studio` (redesign). */
export type EditorUi = "legacy" | "studio";

/**
 * `DECUPA_EDITOR_UI` escolhe o shell no boot. Ausente ou vazia é `legacy`; um
 * valor desconhecido também cai na `legacy`, o estado seguro, mas avisa quem
 * subiu o servidor em vez de ignorar o erro de digitação em silêncio.
 */
export function editorUiFromEnv(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (message) => console.error(message),
): EditorUi {
  const raw = (env.DECUPA_EDITOR_UI ?? "").trim();
  if (raw === "" || raw === "legacy") return "legacy";
  if (raw === "studio") return "studio";
  warn(`aviso: DECUPA_EDITOR_UI=${JSON.stringify(raw)} não é legacy nem studio; servindo a interface legacy`);
  return "legacy";
}
