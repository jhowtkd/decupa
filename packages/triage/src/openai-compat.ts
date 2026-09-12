const DEFAULT_MAX_TOKENS = 16000;
const MAX_TOKENS_CEILING = 64_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export function isRetryable(error: Error): boolean {
  return /HTTP (429|5\d\d)|tempo esgotado|fetch failed|network/i.test(error.message);
}

export function isJsonFormatRejected(error: Error): boolean {
  return /response_format|json_object|unknown.?param|unrecognized.?request/i.test(error.message);
}

export function isBudgetExhausted(error: Error): boolean {
  return /gastou o orçamento inteiro|Suba max_tokens/.test(error.message);
}

export interface ZaiUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningChars: number;
}

export function readChoice(raw: unknown): string {
  const body = raw as Record<string, any>;

  if (body?.error) {
    const { code, message } = body.error;
    throw new Error(`o provedor recusou a chamada (${code ?? "sem código"}): ${message ?? "sem mensagem"}`);
  }

  const choice = body?.choices?.[0];
  if (!choice) {
    throw new Error(`resposta do provedor sem \`choices\`: ${JSON.stringify(raw).slice(0, 200)}`);
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

export interface OpenAiCompatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  who?: string;
  jsonObject?: boolean;
}

export class OpenAiCompatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly who: string;
  private jsonObject: boolean;
  private readonly usageTotals: ZaiUsage = {
    calls: 0, promptTokens: 0, completionTokens: 0, reasoningChars: 0,
  };

  constructor(opts: OpenAiCompatOptions) {
    if (!opts.apiKey) {
      throw new Error(
        "chave de API ausente. Sem ela a análise não roda — monte o keep-list na mão.",
      );
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.maxTokens = Math.max(1, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? 1;
    this.who = opts.who ?? "o provedor";
    this.jsonObject = opts.jsonObject !== false;
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
        if (this.jsonObject && isJsonFormatRejected(error)) {
          this.jsonObject = false;
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
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content }],
      max_tokens: this.maxTokens,
    };
    if (this.jsonObject) payload.response_format = { type: "json_object" };
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if ((err as Error)?.name === "TimeoutError" || (combined.aborted && timeout.aborted)) {
        throw new Error(
          `tempo esgotado depois de ${(this.timeoutMs / 1000).toFixed(0)}s esperando ${this.who}`,
        );
      }
      throw err;
    }

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`HTTP ${res.status} de ${this.who}, corpo não-JSON: ${raw.slice(0, 200)}`);
    }
    if (!res.ok && !(parsed as { error?: unknown })?.error) {
      throw new Error(`HTTP ${res.status} de ${this.who}: ${raw.slice(0, 200)}`);
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
