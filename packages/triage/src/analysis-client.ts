import type { Credentials } from "./credentials.ts";
import { OpenAiCompatClient, type OpenAiCompatOptions } from "./openai-compat.ts";
import { presetConfig, resolveProvider } from "./provider.ts";
import { ZAI_DEFAULT_BASE, ZAI_DEFAULT_MODEL } from "./provider.ts";

export type AnalysisClientOptions = {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  provider?: string;
  stored?: Credentials | null;
  env?: Record<string, string | undefined>;
};

/**
 * Monta as opções do transporte a partir de --provider, credentials e env.
 * apiKey explícito (testes) não passa pelo resolver e usa defaults Z.ai.
 */
export function analysisClientOptions(opts: AnalysisClientOptions = {}): OpenAiCompatOptions {
  const env = opts.env ?? process.env;
  if (opts.apiKey) {
    return {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? ZAI_DEFAULT_BASE,
      model: opts.model ?? ZAI_DEFAULT_MODEL,
      maxTokens: opts.maxTokens,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      who: "a Z.ai",
    };
  }
  const provider = resolveProvider(opts.provider, env, opts.stored);
  const cfg = presetConfig(provider, env, opts.stored);
  const apiKey = (opts.stored?.preset === provider ? opts.stored.apiKey : undefined) ?? env[cfg.envKey];
  if (!apiKey) {
    throw new Error(
      `${cfg.envKey} não está setada. Sem a chave a análise não roda — ` +
      "monte o keep-list na mão e passe direto pro `condense.py plan`.",
    );
  }
  return {
    apiKey,
    baseUrl: opts.baseUrl ?? cfg.baseUrl,
    model: opts.model ?? cfg.model,
    maxTokens: opts.maxTokens,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    who: provider === "zai" ? "a Z.ai" : `o provedor ${provider}`,
  };
}

export function createAnalysisClient(opts: AnalysisClientOptions = {}): OpenAiCompatClient {
  return new OpenAiCompatClient(analysisClientOptions(opts));
}
