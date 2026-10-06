import type { Credentials } from "./credentials.ts";
import { OpenAiCompatClient, type OpenAiCompatOptions } from "./openai-compat.ts";
import { OPENAI_VISUAL_BASE, OPENAI_VISUAL_MODEL, presetConfig, resolveProvider, resolveVisualProvider } from "./provider.ts";
import { payloadProfileKey, type PayloadProfile } from "./payload-profile.ts";
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
 * Um `.decupa/credentials` pode chegar dentro de uma pasta de projeto
 * recebida de outra pessoa. O arquivo vence o ambiente (GUIA §7), então o
 * endpoint dele é conferido na leitura, não só quando foi gravado, e nunca
 * recebe a chave de outro lugar: sem `apiKey` própria, a chave do ambiente
 * ou da empresa iria junto com os quadros para o host que o arquivo escolheu.
 */
export function assertStoredEndpoint(baseUrl: string, apiKey: string | undefined): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // Sem ecoar o valor: uma URL malformada ainda pode carregar segredo.
    throw new Error("credentials do Decupa com baseUrl inválido: use um endpoint HTTPS");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `credentials do Decupa com baseUrl recusado (${url.origin}): use um endpoint HTTPS sem credenciais ou parâmetros na URL.`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `credentials do Decupa definem baseUrl (${url.origin}) sem apiKey própria. A chave do ambiente ou da empresa ` +
      "não é enviada a um endpoint escolhido pelo arquivo: grave apiKey no mesmo arquivo ou remova o baseUrl.",
    );
  }
}

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
  const fromStore = opts.stored?.preset === provider ? opts.stored : null;
  if (fromStore?.baseUrl) assertStoredEndpoint(fromStore.baseUrl, fromStore.apiKey);
  const apiKey = fromStore?.apiKey ?? env[cfg.envKey];
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

export type VisualClientOptions = AnalysisClientOptions & { profile?: PayloadProfile };

export function visualClientOptions(opts: VisualClientOptions = {}): OpenAiCompatOptions {
  const env = opts.env ?? process.env;
  // Overrides de teste são explícitos e não herdam a ativação do shell.
  const visual = opts.apiKey || opts.provider !== undefined || opts.profile === "default"
    ? null : resolveVisualProvider(env);
  if (!visual && opts.profile !== "openai-reasoning-none") return analysisClientOptions(opts);
  const apiKey = opts.apiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY não está setada: a visão Luna não roda; o provedor de texto continua disponível.");
  return {
    apiKey, baseUrl: opts.baseUrl ?? OPENAI_VISUAL_BASE, model: opts.model ?? OPENAI_VISUAL_MODEL,
    profile: "openai-reasoning-none", who: "a OpenAI", maxTokens: opts.maxTokens,
    fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, retries: opts.retries,
  };
}

export function createVisualClient(opts: VisualClientOptions = {}) {
  const resolved = visualClientOptions(opts);
  const client = new OpenAiCompatClient(resolved);
  return {
    model: resolved.model, providerKey: resolved.baseUrl, profileKey: payloadProfileKey(resolved), payloadProfile: resolved.profile ?? "default",
    send: (content: unknown[], signal?: AbortSignal, onAttempt?: () => void) => client.send(content, signal, onAttempt),
    usage: () => client.usage(),
  };
}
