import { DEFAULT_MAX_TOKENS, type PayloadProfile } from "./payload-profile.ts";
import { OpenAiTotalTimeoutError, openAiRetryable, ProviderHttpError, redactOpenAiError, retryAfterMs, waitOpenAiRetry } from "./openai-retry.ts";
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
  const reasoningChars = (choice.message?.reasoning_content ?? "").length;
  // Cortada no teto não é resposta: o JSON sai truncado ou, pior, parseia
  // com metade das decisões. Mesmo remédio do raciocínio que come o teto.
  if (choice.finish_reason === "length" && content.trim().length > 0) {
    throw new Error(
      `a resposta do modelo foi cortada no teto de tokens (finish_reason=length, ${content.length} ` +
      `caracteres de resposta e ${reasoningChars} de raciocínio) e não é confiável. Suba max_tokens.`,
    );
  }
  if (content.trim().length > 0) return content;

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
  profile?: PayloadProfile;
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
  private readonly profile: PayloadProfile;
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
    this.profile = opts.profile ?? "default";
  }

  usage(): ZaiUsage {
    return { ...this.usageTotals };
  }

  async send(content: unknown[], signal?: AbortSignal, onAttempt?: () => void): Promise<string> {
    if (this.profile === "openai-reasoning-none") return this.sendOpenAi(content, signal, onAttempt);
    let retriesLeft = this.retries;
    for (;;) {
      try {
        return await this.once(content, signal, onAttempt);
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

  private async sendOpenAi(content: unknown[], signal?: AbortSignal, onAttempt?: () => void): Promise<string> {
    // Três tentativas no máximo, incluindo a inicial; o teto inclui espera e leitura do corpo.
    const budgetMs = 240_000;
    const deadline = Date.now() + budgetMs;
    const total = AbortSignal.timeout(budgetMs);
    const combined = signal ? AbortSignal.any([signal, total]) : total;
    const retries = Math.min(2, Math.max(0, this.retries));
    try {
      for (let attempt = 0; ; attempt += 1) {
        combined.throwIfAborted();
        try { return await this.once(content, combined, onAttempt); }
        catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (combined.aborted || !openAiRetryable(error) || attempt >= retries) throw error;
          await waitOpenAiRetry(error, attempt, deadline - Date.now(), combined);
        }
      }
    } catch (error) {
      // Cancelamento do usuário conserva AbortError; o teto total explica a causa.
      if (total.aborted && !signal?.aborted) throw new OpenAiTotalTimeoutError();
      throw error;
    }
  }

  /**
   * O timeout cresce com o teto de tokens: o padrão vale para 16k, e dobrar
   * o teto quando o raciocínio come a resposta (até 64k) dobra a espera.
   * Com 120 s fixos, a chamada de 64k estourava antes de poder terminar.
   */
  private timeoutForBudget(): number {
    return Math.round(this.timeoutMs * Math.max(1, this.maxTokens / DEFAULT_MAX_TOKENS));
  }

  private async once(content: unknown[], signal?: AbortSignal, onAttempt?: () => void): Promise<string> {
    const timeoutMs = this.timeoutForBudget();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content }],
      max_tokens: this.maxTokens,
    };
    if (this.profile === "openai-reasoning-none") {
      // O contrato é explícito; não inferimos capabilities pelo nome do modelo.
      payload.messages = [{ role: "user", content: content.map((part: any) => part?.type === "image_url"
        ? { ...part, image_url: { ...part.image_url, detail: "auto" } } : part) }];
      delete payload.max_tokens;
      payload.reasoning_effort = "none";
      payload.max_completion_tokens = this.maxTokens;
      payload.store = false;
    }
    // GLM-5.3 defaults to maximum reasoning, too slow for interactive text edits
    // and for the cleanup triage, which sends the whole video: at maximum it ate
    // the token ceiling and the timeout. Image analysis and other models keep
    // their existing settings.
    const kinds = content.map((part) => typeof part === "string"
      ? "text"
      : part !== null && typeof part === "object" && "type" in part ? String(part.type) : "other");
    const textOnly = kinds.every((kind) => kind === "text");
    const withVideo = kinds.includes("video_url") && kinds.every((kind) => kind === "text" || kind === "video_url");
    if (this.profile === "default" && this.model.toLowerCase() === "glm-5.3-flash" && (textOnly || withVideo)) payload.reasoning_effort = "low";
    if (this.jsonObject || this.profile === "openai-reasoning-none") payload.response_format = { type: "json_object" };
    let res: Response;
    try {
      onAttempt?.();
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
          `tempo esgotado depois de ${(timeoutMs / 1000).toFixed(0)}s esperando ${this.who}`,
        );
      }
      throw err;
    }

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (this.profile === "openai-reasoning-none") {
        throw new ProviderHttpError(res.status, undefined, retryAfterMs(res.headers.get("retry-after")), redactOpenAiError(`HTTP ${res.status} de ${this.who}, corpo não-JSON: ${raw}`, this.apiKey));
      }
      throw new Error(`HTTP ${res.status} de ${this.who}, corpo não-JSON: ${raw.slice(0, 200)}`);
    }
    if (this.profile === "openai-reasoning-none" && (!res.ok || (parsed as { error?: unknown })?.error)) {
      const error = (parsed as { error?: { code?: string; message?: string } })?.error;
      throw new ProviderHttpError(res.status, error?.code, retryAfterMs(res.headers.get("retry-after")),
        redactOpenAiError(`HTTP ${res.status} de ${this.who} (${error?.code ?? "sem código"}): ${error?.message ?? raw}`, this.apiKey));
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
