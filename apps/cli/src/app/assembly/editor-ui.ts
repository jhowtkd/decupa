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

const STUDIO_META = '<meta name="decupa-editor-ui" content="studio">';

/**
 * Shell do studio das telas com script inline (Configurações, Limpeza de fala,
 * marcação manual): o mesmo HTML da legacy com a meta da variante e o
 * studio.css no fim do `<head>`. Ids e script ficam idênticos, então o studio
 * dessas telas só muda por CSS. A legacy nunca passa por aqui; aplicar de novo
 * devolve o mesmo HTML.
 */
export function withStudioShell(html: string, cssHref: string): string {
  if (html.includes(STUDIO_META)) return html;
  const end = html.indexOf("</head>");
  if (end < 0) throw new Error("Shell do studio indisponível: falta </head> no HTML da tela.");
  return `${html.slice(0, end)}${STUDIO_META}<link rel="stylesheet" href="${cssHref}">${html.slice(end)}`;
}
