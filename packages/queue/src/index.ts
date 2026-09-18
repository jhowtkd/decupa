export class CancelledError extends Error {
  readonly name = "CancelledError";
  constructor(message = "operação cancelada") {
    super(message);
  }
}

export function isCancelledError(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "CancelledError";
}

function cancelled(reason?: unknown): CancelledError {
  const error = new CancelledError();
  if (reason instanceof Error) error.cause = reason;
  return error;
}

export interface QueueRunOptions {
  signal?: AbortSignal;
  key?: string;
}

export interface LimitedQueue {
  readonly inFlight: number;
  readonly maxInFlight: number;
  readonly waiting: number;
  readonly maxWaiting: number;
  run<T>(work: () => Promise<T> | T, opts?: QueueRunOptions): Promise<T>;
  map<T, R>(
    items: readonly T[],
    mapper: (item: T, index: number) => Promise<R> | R,
    opts?: { signal?: AbortSignal },
  ): Promise<R[]>;
}

type Waiter = {
  grant: () => void;
  fail: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export function createLimitedQueue(limit: number): LimitedQueue {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limite de concorrência precisa ser um inteiro >= 1");
  }

  let inFlight = 0;
  let maxInFlight = 0;
  let maxWaiting = 0;
  const waiters: Waiter[] = [];
  const shared = new Map<string, Promise<unknown>>();

  const markStart = (): void => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
  };

  const release = (): void => {
    inFlight = Math.max(0, inFlight - 1);
    const next = waiters.shift();
    if (!next) return;
    if (next.onAbort && next.signal) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.grant();
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(cancelled(signal.reason));
    if (inFlight < limit) {
      markStart();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          markStart();
          resolve();
        },
        fail: reject,
        signal,
      };
      const onAbort = (): void => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(cancelled(signal?.reason));
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
      maxWaiting = Math.max(maxWaiting, waiters.length);
    });
  };

  const follow = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) throw cancelled(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(cancelled(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  const queue: LimitedQueue = {
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    get waiting() {
      return waiters.length;
    },
    get maxWaiting() {
      return maxWaiting;
    },
    async run<T>(work: () => Promise<T> | T, opts?: QueueRunOptions): Promise<T> {
      if (opts?.signal?.aborted) throw cancelled(opts.signal.reason);
      const runUnkeyed = async (): Promise<T> => {
        await acquire(opts?.key ? undefined : opts?.signal);
        try {
          return await work();
        } finally {
          release();
        }
      };
      if (opts?.key) {
        const key = opts.key;
        let pending = shared.get(key) as Promise<T> | undefined;
        if (!pending) {
          pending = runUnkeyed().finally(() => {
            shared.delete(key);
          });
          shared.set(key, pending);
        }
        return follow(pending, opts.signal);
      }
      return runUnkeyed();
    },
    map<T, R>(
      items: readonly T[],
      mapper: (item: T, index: number) => Promise<R> | R,
      opts?: { signal?: AbortSignal },
    ): Promise<R[]> {
      return Promise.all(items.map((item, index) => queue.run(() => mapper(item, index), { signal: opts?.signal })));
    },
  };
  return queue;
}

export function createSerialQueue(): LimitedQueue {
  return createLimitedQueue(1);
}
