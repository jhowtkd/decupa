export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";

/**
 * A Z.ai serve dois endpoints quase idênticos que cobram de formas diferentes:
 * `/api/paas/v4` é pay-as-you-go e precisa de crédito pré-carregado, enquanto
 * `/api/coding/paas/v4` é a assinatura do Coding Plan. Assinante que bate no
 * primeiro recebe `1113 — Insufficient balance`, que parece erro de conta
 * vazia e é erro de endereço.
 */
export const ZAI_DEFAULT_BASE = "https://api.z.ai/api/coding/paas/v4/chat/completions";

const DEFAULT_MAX_TOKENS = 16000;
const MAX_TOKENS_CEILING = 64_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Um retry: 429 e 5xx passam, corpo malformado e endpoint errado não. */
export function isRetryable(error: Error): boolean {
  return /HTTP (429|5\d\d)|tempo esgotado|fetch failed|network/i.test(error.message);
}

/** O thinking comeu o orçamento e não sobrou resposta. */
export function isBudgetExhausted(error: Error): boolean {
  return /gastou o orçamento inteiro|Suba max_tokens/.test(error.message);
}

/** Consumo acumulado desta instância entre os passes. */
export interface ZaiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningChars: number;
}

/** Extrai o texto da resposta, ou estoura dizendo por que não deu. */
export function readChoice(raw: unknown): string {
  const body = raw as Record<string, any>;

  if (body?.error) {
    const { code, message } = body.error;
    throw new Error(`a Z.ai recusou a chamada (${code ?? "sem código"}): ${message ?? "sem mensagem"}`);
  }

  const choice = body?.choices?.[0];
  if (!choice) {
    throw new Error(`resposta da Z.ai sem \`choices\`: ${JSON.stringify(raw).slice(0, 200)}`);
  }

  const content: string = choice.message?.content ?? "";
  if (content.trim().length > 0) return content;

  const reasoningChars = (choice.message?.reasoning_content ?? "").length;
  if (choice.finish_reason === "length") {
    throw new Error(
      `o modelo gastou o orçamento inteiro pensando (${reasoningChars} caracteres de raciocínio) ` +
      "e não sobrou resposta. Suba max_tokens.",
    );
  }
  throw new Error(
    `o modelo terminou com \`${choice.finish_reason}\` e devolveu resposta vazia ` +
    `(${reasoningChars} caracteres de raciocínio).`,
  );
}

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
  private readonly model: string;
  private readonly baseUrl: string;
  private maxTokens: number;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly usageTotals: ZaiUsage = {
    calls: 0, promptTokens: 0, completionTokens: 0, reasoningChars: 0,
  };

  constructor(opts: ZaiClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ZAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ZAI_API_KEY não está setada. A triagem precisa dela para ler o vídeo. " +
        "Sem a chave, monte o keep-list na mão e passe direto pro `condense.py plan`.",
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? ZAI_DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE;
    this.maxTokens = Math.max(1, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? 1;
  }

  usage(): ZaiUsage {
    return { ...this.usageTotals };
  }

  async send(content: unknown[], signal?: AbortSignal): Promise<string> {
    let retriesLeft = this.retries;
    for (;;) {
      try {
        return await this.once(content, signal);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === "AbortError" || signal?.aborted) throw error;
        if (isBudgetExhausted(error) && this.maxTokens < MAX_TOKENS_CEILING) {
          this.maxTokens = Math.min(this.maxTokens * 2, MAX_TOKENS_CEILING);
          continue;
        }
        if (!isRetryable(error) || retriesLeft <= 0) throw error;
        retriesLeft -= 1;
      }
    }
  }

  private async once(content: unknown[], signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content }],
          response_format: { type: "json_object" },
          max_tokens: this.maxTokens,
        }),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if ((err as Error)?.name === "TimeoutError" || combined.aborted && timeout.aborted) {
        throw new Error(
          `tempo esgotado depois de ${(this.timeoutMs / 1000).toFixed(0)}s esperando a Z.ai`,
        );
      }
      throw err;
    }

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`HTTP ${res.status} da Z.ai, corpo não-JSON: ${raw.slice(0, 200)}`);
    }
    if (!res.ok && !(parsed as any)?.error) {
      throw new Error(`HTTP ${res.status} da Z.ai: ${raw.slice(0, 200)}`);
    }
    const usage = (parsed as Record<string, any>)?.usage;
    if (usage && Number.isFinite(usage.prompt_tokens)) {
      this.usageTotals.calls += 1;
      this.usageTotals.promptTokens += Number(usage.prompt_tokens);
      this.usageTotals.completionTokens += Number(usage.completion_tokens ?? 0);
    }
    const reasoning = (parsed as Record<string, any>)?.choices?.[0]?.message?.reasoning_content;
    this.usageTotals.reasoningChars += String(reasoning ?? "").length;
    return readChoice(parsed);
  }
}
