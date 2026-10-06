import { createVisualClient, payloadProfileKey, resolveVisualProvider, type Credentials, type TriageModel, type ZaiUsage } from "@decupa/triage";
import { ProviderHttpError } from "../../../packages/triage/src/openai-retry.ts";

/** Inspect tem sua própria identidade; structure e density mantêm o cache de texto. */
export function triageVisual(opts: {
  env: Record<string, string | undefined>; stored: Credentials | null; provider: string;
  modelName: string; providerId: string; maxTokens?: number; fetchImpl?: typeof fetch; model?: TriageModel;
}): { modelName: string; providerId: string; client?: { send(content: unknown[], signal?: AbortSignal): Promise<string>; usage?(): ZaiUsage } } {
  const resolved = resolveVisualProvider(opts.env);
  // Sem ativar Luna, inclusive com orçamento customizado, vale a identidade anterior.
  if (!resolved) return { modelName: opts.modelName, providerId: opts.providerId, client: undefined };
  const identity = {
    modelName: resolved.model,
    providerId: `openai|${resolved.model}|${resolved.baseUrl}|${payloadProfileKey({ profile: resolved.profile, maxTokens: opts.maxTokens })}`,
  };
  if (opts.model) return { ...identity, client: undefined };
  try { return { ...identity, client: createVisualClient({ env: opts.env, stored: opts.stored, maxTokens: opts.maxTokens, fetchImpl: opts.fetchImpl }) }; }
  catch (error) {
    // Chave visual ausente não impede os passes textuais; inspect vira revisão, sem fallback.
    return { ...identity, client: { send: async () => { throw error; } } };
  }
}

/** A causa da falha visual deve aparecer sem ecoar corpo ou chave do provedor. */
export function inspectFailure(error: unknown): { message: string; permanent: boolean } {
  const message = error instanceof Error ? error.message : "";
  if (/OPENAI_API_KEY/.test(message)) return { message: "visão: chave OpenAI ausente", permanent: true };
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return { message: "visão: chave OpenAI recusada", permanent: true };
    if (error.code === "insufficient_quota") return { message: "visão: cota OpenAI esgotada", permanent: true };
  }
  if (message === "visão: tempo total de tentativas esgotado") return { message, permanent: false };
  return { message: "inspect: resposta inválida, para revisão", permanent: false };
}
