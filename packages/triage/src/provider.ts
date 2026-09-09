export type Provider = "zai";

/**
 * O decupa usa um provedor só: Z.ai (GLM 5.3 Flash). Esta função existe para
 * dar a mesma mensagem de erro boa nos dois pontos de entrada (CLI e app) —
 * chave ausente e flag inválida estouram dizendo o que fazer, não
 * "cannot read properties of undefined".
 */
export function resolveProvider(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Provider {
  if (explicit !== undefined) {
    if (explicit === "zai") return "zai";
    throw new Error(
      `--provider aceita "zai", não "${explicit}" — o caminho Gemini foi ` +
      "retirado; a triagem do decupa é Z.ai (GLM).",
    );
  }
  if (env.ZAI_API_KEY) return "zai";
  throw new Error(
    "ZAI_API_KEY não está setada no ambiente. Sem chave a triagem não roda — " +
    "monte o keep-list na mão e passe direto pro `condense.py plan`, que é o " +
    "caminho que o SKILL documenta.",
  );
}
