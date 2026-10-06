import { setTimeout as delay } from "node:timers/promises";

/** Guarda status e código mesmo quando o corpo traz error ou não é JSON. */
export class ProviderHttpError extends Error {
  readonly retryHandled = true;
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(
    status: number, code: string | undefined,
    retryAfterMs: number | undefined, message: string,
  ) {
    super(message);
    this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
  }
}

export class OpenAiTotalTimeoutError extends Error {
  readonly retryHandled = true;
  constructor() { super("visão: tempo total de tentativas esgotado"); }
}

/** Erros podem ir ao projeto e à UI: nem a chave mascarada deve sair do transporte. */
export function redactOpenAiError(message: string, apiKey: string): string {
  return message.split(apiKey).join("[chave omitida]").replace(/\bsk-[^\s"'<>),;:]+/giu, "[chave omitida]").slice(0, 300);
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function openAiRetryable(error: Error): boolean {
  if (error instanceof ProviderHttpError) {
    if (/quota|billing|credit/i.test(`${error.code ?? ""} ${error.message}`)) return false;
    return error.status === 429 || error.status >= 500 && error.status < 600;
  }
  return /tempo esgotado|fetch failed|network/i.test(error.message);
}

/** Nunca encurta Retry-After: se não cabe no teto total, não despacha outra chamada. */
export async function waitOpenAiRetry(error: Error, attempt: number, remainingMs: number, signal: AbortSignal) {
  const waitMs = error instanceof ProviderHttpError && error.retryAfterMs !== undefined
    ? error.retryAfterMs : Math.min(10_000, 500 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
  if (waitMs >= remainingMs) throw error;
  await delay(waitMs, undefined, { signal });
}
