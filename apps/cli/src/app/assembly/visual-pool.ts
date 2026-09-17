import { createLimitedQueue, type LimitedQueue } from "@decupa/queue";

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_JITTER = 0.25;
const DEFAULT_RETRY_BUDGET_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export type VisualPoolOptions = {
  ffmpegLimit: number;
  networkLimit: number;
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
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 429|HTTP 529/.test(message);
}

function backoffMs(attempt: number, random: () => number): number {
  return BACKOFF_INITIAL_MS * 2 ** attempt * (1 - random() * BACKOFF_JITTER);
}

export function createVisualPools(opts: VisualPoolOptions): VisualPools {
  const ffmpeg: LimitedQueue = createLimitedQueue(opts.ffmpegLimit);
  const network: LimitedQueue = createLimitedQueue(opts.networkLimit);
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
    mapWindows<W, R>(
      windows: readonly W[],
      mapper: (window: W, index: number) => Promise<R> | R,
      _runOpts?: VisualPoolRunOptions,
    ): Promise<R[]> {
      return Promise.all(windows.map((window, index) => Promise.resolve().then(() => mapper(window, index))));
    },
  };
  return pools;
}
