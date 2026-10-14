import { OPENAI_ASSEMBLY_TEXT_MODEL, OPENAI_VISUAL_MODEL, type Credentials } from "@decupa/triage";
import { optionalProviderKey } from "./provider-validation.ts";

export const NO_FREE_KEY_TEST = "Este provedor não oferece teste sem custo";
export const KEY_TEST_TIMEOUT_MS = 10_000;

/** Somente consultas oficiais verificadas; nunca inferimos /models de um endpoint arbitrário. */
export async function testProviderKey(body: Record<string, unknown>, env: Record<string, string | undefined>,
  stored: Credentials | null, fetchImpl: typeof fetch = fetch) {
  if (!["visual", "openai", "text", "jev"].includes(String(body.section))
    || Object.keys(body).some(key => !["section", "key", "preset", "baseUrl", "model"].includes(key))) throw new Error("Configuração inválida.");
  if (body.section === "text" || body.section === "jev") return { available: false, message: NO_FREE_KEY_TEST };
  // Um teste OpenAI não aceita destino escolhido pelo navegador.
  if (body.preset !== undefined || body.baseUrl !== undefined || body.model !== undefined) throw new Error("Configuração inválida.");
  const typed = optionalProviderKey(body.key);
  const key = typed || env.OPENAI_API_KEY?.trim() || stored?.openaiApiKey;
  const source = typed ? "input" : env.OPENAI_API_KEY?.trim() ? "environment"
    : (stored as (Credentials & { openaiApiKeySource?: string }) | null)?.openaiApiKeySource ?? "credentials";
  if (!key) return { available: true, source: "default", message: "Configure a chave OpenAI antes de testar.", models: [] };
  const signal = AbortSignal.timeout(KEY_TEST_TIMEOUT_MS);
  const models = await Promise.all([OPENAI_VISUAL_MODEL, OPENAI_ASSEMBLY_TEXT_MODEL].map(async model => {
    let message = "Não foi possível conectar";
    try {
      const response = await fetchImpl(`https://api.openai.com/v1/models/${model}`, {
        method: "GET", headers: { Authorization: `Bearer ${key}` }, signal, redirect: "error",
      });
      if (response.ok) message = "Chave funcionando";
      else if (response.status === 401 || response.status === 403) message = "Chave recusada (401/403)";
      else if (response.status === 404) message = `Sem acesso ao modelo ${model}`;
      else if (response.status === 429) message = "Limite ou saldo (429)";
      // O corpo remoto não entra em resposta, exceção ou log; não contém evidência necessária.
      await response.body?.cancel().catch(() => undefined);
    } catch { /* Rede, timeout e redirecionamento têm a mesma mensagem fixa. */ }
    return { model, message };
  }));
  const failures = [...new Set(models.filter(item => item.message !== "Chave funcionando").map(item => item.message))];
  return { available: true, source, message: failures.length ? failures.join(". ") : "Chave funcionando", models };
}
