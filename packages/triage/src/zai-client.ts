import { OpenAiCompatClient, type OpenAiCompatOptions } from "./openai-compat.ts";

export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";

/**
 * A Z.ai serve dois endpoints quase idênticos que cobram de formas diferentes:
 * `/api/paas/v4` é pay-as-you-go e precisa de crédito pré-carregado, enquanto
 * `/api/coding/paas/v4` é a assinatura do Coding Plan. Assinante que bate no
 * primeiro recebe `1113 — Insufficient balance`, que parece erro de conta
 * vazia e é erro de endereço.
 */
export const ZAI_DEFAULT_BASE = "https://api.z.ai/api/coding/paas/v4/chat/completions";

export {
  isBudgetExhausted,
  isRetryable,
  readChoice,
} from "./openai-compat.ts";
export type { ZaiUsage } from "./openai-compat.ts";

export interface ZaiClientOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export class ZaiClient {
  private readonly inner: OpenAiCompatClient;

  constructor(opts: ZaiClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ZAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ZAI_API_KEY não está setada. A triagem precisa dela para ler o vídeo. " +
        "Sem a chave, monte o keep-list na mão e passe direto pro `condense.py plan`.",
      );
    }
    const innerOpts: OpenAiCompatOptions = {
      apiKey,
      model: opts.model ?? ZAI_DEFAULT_MODEL,
      baseUrl: opts.baseUrl ?? process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE,
      maxTokens: opts.maxTokens,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      who: "a Z.ai",
    };
    this.inner = new OpenAiCompatClient(innerOpts);
  }

  usage() {
    return this.inner.usage();
  }

  send(content: unknown[], signal?: AbortSignal): Promise<string> {
    return this.inner.send(content, signal);
  }
}
