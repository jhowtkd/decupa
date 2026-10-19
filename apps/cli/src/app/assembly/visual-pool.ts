import { createLimitedQueue, type LimitedQueue } from "@decupa/queue";

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_JITTER = 0.25;
const DEFAULT_RETRY_BUDGET_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export type VisualPoolOptions = {
  ffmpegLimit: number;
  networkLimit: number;
  /** Janelas em extração, espera, resposta ou publicação, somadas. */
  windowLimit?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retryBudgetMs?: number;
  maxRetries?: number;
};

export type VisualPoolRunOptions = {
  signal?: AbortSignal;
};

export type VisualPools = {
  encode<T>(work: () => Promise<T> | T, opts?: VisualPoolRunOptions): Promise<T>;
  request<T>(work: () => Promise<T> | T, opts?: VisualPoolRunOptions): Promise<T>;
  mapWindows<W, R>(
    windows: readonly W[],
    mapper: (window: W, index: number) => Promise<R> | R,
    opts?: VisualPoolRunOptions,
  ): Promise<R[]>;
};

export function isVisualRetryable(error: unknown): boolean {
  // O transporte OpenAI já consumiu sua política limitada e Retry-After.
  if (error && typeof error === "object" && "retryHandled" in error && error.retryHandled === true) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 429|HTTP 529/.test(message);
}

function backoffMs(attempt: number, random: () => number): number {
  return BACKOFF_INITIAL_MS * 2 ** attempt * (1 - random() * BACKOFF_JITTER);
}

const DEFAULT_FFMPEG_LIMIT = 2;
const DEFAULT_NETWORK_LIMIT = 2;
// Duas requisições + até duas janelas antecipadas, sem acumular o vídeo todo.
const DEFAULT_WINDOW_LIMIT = 4;

let shared: VisualPools | undefined;

/** Orçamento de processo compartilhado entre janelas visuais e inspect. */
export function sharedVisualPools(): VisualPools {
  shared ??= createVisualPools({
    ffmpegLimit: DEFAULT_FFMPEG_LIMIT,
    networkLimit: DEFAULT_NETWORK_LIMIT,
  });
  return shared;
}

export function createVisualPools(opts: VisualPoolOptions): VisualPools {
  const ffmpeg: LimitedQueue = createLimitedQueue(opts.ffmpegLimit);
  const network: LimitedQueue = createLimitedQueue(opts.networkLimit);
  const windowLimit = opts.windowLimit ?? DEFAULT_WINDOW_LIMIT;
  const windowQueue: LimitedQueue = createLimitedQueue(windowLimit);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const retryBudgetMs = opts.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const requestOnce = async <T>(work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> => {
    const startedAt = now();
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("AbortError");
      try {
        return await work();
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!isVisualRetryable(error) || attempt >= maxRetries) throw error;
        const delay = backoffMs(attempt, random);
        const elapsed = Math.max(0, now() - startedAt);
        if (elapsed + delay >= retryBudgetMs) throw error;
        await sleep(delay);
        attempt += 1;
      }
    }
  };

  const pools: VisualPools = {
    encode<T>(work: () => Promise<T> | T, runOpts?: VisualPoolRunOptions): Promise<T> {
      return ffmpeg.run(work, { signal: runOpts?.signal });
    },
    request<T>(work: () => Promise<T> | T, runOpts?: VisualPoolRunOptions): Promise<T> {
      return network.run(() => requestOnce(work, runOpts?.signal), { signal: runOpts?.signal });
    },
    async mapWindows<W, R>(
      windows: readonly W[],
      mapper: (window: W, index: number) => Promise<R> | R,
      runOpts?: VisualPoolRunOptions,
    ): Promise<R[]> {
      runOpts?.signal?.throwIfAborted();
      const results: R[] = [];
      let nextIndex = 0;
      let failed = false;
      let firstError: unknown;
      // Cancela só a admissão desta chamada; mappers ativos conservam seu
      // sinal original e precisam terminar antes da rejeição do mapeamento.
      const admission = new AbortController();
      const admissionSignal = runOpts?.signal
        ? AbortSignal.any([runOpts.signal, admission.signal])
        : admission.signal;
      const fail = (error: unknown): void => {
        if (failed) return;
        firstError = error;
        failed = true;
        admission.abort(error);
      };

      // Poucos workers pegam a próxima janela só após publicar a anterior.
      // A fila é do pool, não da chamada: fontes simultâneas dividem o teto.
      // Não cadastramos uma promise/listener por janela da fonte inteira.
      const worker = async (): Promise<void> => {
        while (!failed && nextIndex < windows.length) {
          try {
            runOpts?.signal?.throwIfAborted();
            const index = nextIndex++;
            results[index] = await windowQueue.run(async () => {
              if (failed) throw firstError;
              runOpts?.signal?.throwIfAborted();
              try {
                return await mapper(windows[index]!, index);
              } catch (error) {
                // Registra antes de liberar o slot, pois a fila pode admitir
                // outro worker desta chamada antes do catch externo rodar.
                fail(error);
                throw error;
              }
            }, { signal: admissionSignal });
          } catch (error) {
            fail(error);
          }
        }
      };
      // Drena os mappers já admitidos antes de devolver erro/cancelamento:
      // nenhum trabalho desta chamada continua publicando após seu término.
      await Promise.all(Array.from({ length: Math.min(windowLimit, windows.length) }, worker));
      if (failed) throw firstError;
      return results;
    },
  };
  return pools;
}
