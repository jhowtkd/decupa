export type Provider = "gemini" | "zai";

/**
 * Qual motor responde. Explícito ganha sempre; sem flag, quem manda é a chave
 * presente no ambiente.
 *
 * O default fixo em "gemini" fazia quem só tem ZAI_API_KEY receber
 * "GEMINI_API_KEY não está setada" — um erro que descreve um provedor que a
 * pessoa nunca escolheu, e que manda investigar a conta errada.
 */
export function resolveProvider(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Provider {
  if (explicit !== undefined) {
    if (explicit !== "gemini" && explicit !== "zai") {
      throw new Error(`--provider aceita "gemini" ou "zai", não "${explicit}"`);
    }
    return explicit;
  }
  if (env.ZAI_API_KEY) return "zai";
  if (env.GEMINI_API_KEY) return "gemini";
  throw new Error(
    "nenhuma chave de triagem no ambiente: sete ZAI_API_KEY ou GEMINI_API_KEY. " +
    "Sem chave a triagem não roda — monte o keep-list na mão e passe direto " +
    "pro `condense.py plan`, que é o caminho que o SKILL documenta.",
  );
}
