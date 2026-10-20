import { CancelledError } from "@decupa/trace";

export const DEFAULT_TYPESAFE_TOTAL_MS = 300_000;
export const DEFAULT_TYPESAFE_MAX_CALLS = 100;

export class TypeSafeTimeoutError extends Error {
  readonly name = "TypeSafeTimeoutError";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`prazo da requisição TypeSafe esgotado (${timeoutMs} ms)`);
    this.timeoutMs = timeoutMs;
  }
}

export class TypeSafeBudgetExceededError extends Error {
  readonly name = "TypeSafeBudgetExceededError";
  readonly reason: "time" | "calls";
  constructor(reason: "time" | "calls") {
    super(reason === "time" ? "orçamento de tempo esgotado" : "orçamento de chamadas esgotado");
    this.reason = reason;
  }
}

function duration(value: number): number {
  // Os timers de Node aceitam até 2^31 - 1 ms; valores maiores viram 1 ms.
  if (!Number.isFinite(value) || value < 0 || value > 2 ** 31 - 1) {
    throw new RangeError("prazo deve ser finito, não negativo e caber em um timer");
  }
  return value;
}

/** O race também encerra adaptadores que ignoram AbortSignal. */
function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
  signal?: AbortSignal,
  now: () => number = () => performance.now(),
): Promise<T> {
  duration(timeoutMs);
  if (signal?.aborted) return Promise.reject(new CancelledError());
  if (timeoutMs <= 0) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const startedAt = now();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Rejeitar antes de abortar preserva a causa mesmo se o transporte
      // responder ao abort imediatamente com um AbortError genérico.
      reject(error);
      controller.abort(error);
    };
    const cancel = () => fail(new CancelledError());
    const timer = setTimeout(() => fail(timeoutError()), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) return cancel();
    try {
      const pending = work(controller.signal);
      Promise.resolve(pending).then(value => {
        if (settled) return;
        if (signal?.aborted) return cancel();
        if (now() - startedAt >= timeoutMs) return fail(timeoutError());
        settled = true;
        cleanup();
        resolve(value);
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export type TypeSafeBudgetOptions = {
  maxDurationMs?: number;
  maxCalls?: number;
  now?: () => number;
};

/** Compartilhe a instância entre proposta, reparo JSON e lotes de decisão.
 * O relógio começa no primeiro uso e inclui intervalos/backoffs; não há reset.
 * Cada run reserva uma chamada antes de iniciar o trabalho, inclusive em erro.
 * Transportes com retry devem chamar onAttempt antes de cada fetch: a primeira
 * tentativa já está reservada; as seguintes consomem o mesmo orçamento.
 */
export class TypeSafeBudget {
  private readonly maxDurationMs: number;
  private readonly maxCalls: number;
  private readonly now: () => number;
  private startedAt?: number;
  private usedCalls = 0;
  private timeExhausted = false;

  constructor(opts: TypeSafeBudgetOptions = {}) {
    this.maxDurationMs = duration(opts.maxDurationMs ?? DEFAULT_TYPESAFE_TOTAL_MS);
    this.maxCalls = opts.maxCalls ?? DEFAULT_TYPESAFE_MAX_CALLS;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 0) {
      throw new RangeError("maxCalls deve ser um inteiro não negativo");
    }
    this.now = opts.now ?? (() => performance.now());
  }

  get callsUsed(): number { return this.usedCalls; }

  get remainingMs(): number {
    if (this.timeExhausted) return 0;
    return Math.max(0, this.maxDurationMs - (this.startedAt === undefined ? 0 : Math.max(0, this.now() - this.startedAt)));
  }

  private reserveCall(): void {
    if (this.remainingMs <= 0) throw new TypeSafeBudgetExceededError("time");
    if (this.usedCalls >= this.maxCalls) throw new TypeSafeBudgetExceededError("calls");
    this.usedCalls += 1;
  }

  async run<T>(work: (signal: AbortSignal, onAttempt: () => void) => Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    if (signal?.aborted) throw new CancelledError();
    if (timeoutMs !== undefined) duration(timeoutMs);
    if (timeoutMs === 0) throw new TypeSafeTimeoutError(timeoutMs);
    this.reserveCall();
    let firstAttempt = true;
    return this.withinTime(requestSignal => work(requestSignal, () => {
      if (requestSignal.aborted) throw new CancelledError();
      if (this.remainingMs <= 0) throw new TypeSafeBudgetExceededError("time");
      if (firstAttempt) firstAttempt = false;
      else this.reserveCall();
    }), signal, timeoutMs);
  }

  /** Limita um workflow (incluindo backoff), sem contar outra chamada remota. */
  async withinTime<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    if (signal?.aborted) throw new CancelledError();
    if (timeoutMs !== undefined) duration(timeoutMs);
    this.startedAt ??= this.now();
    const remaining = this.remainingMs;
    const budgetFirst = timeoutMs === undefined || remaining <= timeoutMs;
    return withDeadline(work, Math.min(remaining, timeoutMs ?? remaining), () => {
      if (!budgetFirst) return new TypeSafeTimeoutError(timeoutMs!);
      this.timeExhausted = true;
      return new TypeSafeBudgetExceededError("time");
    }, signal, this.now);
  }
}
