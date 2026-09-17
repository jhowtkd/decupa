import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CancelledError, isCancelledError } from "@decupa/queue";
import { inspectArtifact, publishAtomic } from "@decupa/cache";

export type TaskPriority = "interactive" | "batch";

export class AbandonedError extends Error {
  readonly name = "AbandonedError";
  constructor(message = "execução abandonada; resultado não publicado") {
    super(message);
  }
}

export type CoordinatorRunOptions<T> = {
  id: string;
  stage: string;
  priority?: TaskPriority;
  signal?: AbortSignal;
  build: () => Promise<T> | T;
};

export type FileCoordinatorOptions = {
  limit?: number;
  leaseMs?: number;
  pollMs?: number;
  now?: () => number;
};

export type FileCoordinator = {
  run<T>(opts: CoordinatorRunOptions<T>): Promise<T>;
};

type TaskRecord = {
  id: string;
  stage: string;
  status: "pending" | "running" | "completed" | "failed";
  priority: TaskPriority;
  leaseId: string | null;
  leaseUntil: number;
  result?: unknown;
};

type Waiter = {
  waiterId: string;
  taskId: string;
  priority: TaskPriority;
  at: number;
};

type Slot = { leaseId: string; until: number };

type Claim =
  | { kind: "done"; result: unknown }
  | { kind: "slot"; index: number; leaseId: string };

const DEFAULT_LIMIT = 1;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 25;

function lockBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY";
}

export function createFileCoordinator(dir: string, opts: FileCoordinatorOptions = {}): FileCoordinator {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limite do coordenador precisa ser um inteiro >= 1");
  }
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  const liveClock = opts.now === undefined;

  const paths = {
    tasks: join(dir, "tasks"),
    slots: join(dir, "slots"),
    waiters: join(dir, "waiters.json"),
    lock: join(dir, ".lock"),
  };

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    await mkdir(dir, { recursive: true });
    for (;;) {
      try {
        const handle = await open(paths.lock, "wx");
        await handle.close();
        break;
      } catch (error) {
        if (!lockBusy(error)) throw error;
        await sleep(pollMs);
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(paths.lock).catch(() => undefined);
    }
  };

  const taskPath = (id: string): string => join(paths.tasks, `${encodeURIComponent(id)}.json`);

  const readTask = async (id: string): Promise<TaskRecord | null> => {
    const inspection = await inspectArtifact(taskPath(id));
    if (inspection.status !== "ready") return null;
    return inspection.value as TaskRecord;
  };

  const writeTask = async (record: TaskRecord): Promise<void> => {
    await mkdir(paths.tasks, { recursive: true });
    await publishAtomic(taskPath(record.id), `${JSON.stringify(record)}\n`);
  };

  const readWaiters = async (): Promise<Waiter[]> => {
    try {
      const raw = JSON.parse(await readFile(paths.waiters, "utf8")) as Waiter[];
      const cutoff = now() - leaseMs * 4;
      return raw.filter((w) => w.at >= cutoff);
    } catch {
      return [];
    }
  };

  const writeWaiters = async (waiters: Waiter[]): Promise<void> => {
    await publishAtomic(paths.waiters, `${JSON.stringify(waiters)}\n`);
  };

  const readSlot = async (index: number): Promise<Slot | null> => {
    const inspection = await inspectArtifact(join(paths.slots, `${index}.json`));
    if (inspection.status !== "ready") return null;
    return inspection.value as Slot;
  };

  const writeSlot = async (index: number, slot: Slot): Promise<void> => {
    await mkdir(paths.slots, { recursive: true });
    await publishAtomic(join(paths.slots, `${index}.json`), `${JSON.stringify(slot)}\n`);
  };

  const freeSlot = async (index: number, leaseId: string): Promise<void> => {
    const current = await readSlot(index);
    if (current?.leaseId !== leaseId) return;
    await unlink(join(paths.slots, `${index}.json`)).catch(() => undefined);
  };

  const rank = (waiter: Waiter): number => (waiter.priority === "interactive" ? 0 : 1);

  const isHead = (waiters: Waiter[], waiterId: string): boolean => {
    const ordered = [...waiters].sort((a, b) => rank(a) - rank(b) || a.at - b.at || a.waiterId.localeCompare(b.waiterId));
    return ordered[0]?.waiterId === waiterId;
  };

  const claimWork = async (
    waiterId: string,
    taskId: string,
    stage: string,
    priority: TaskPriority,
  ): Promise<Claim | null> => {
    return withLock(async () => {
      const existing = await readTask(taskId);
      if (existing?.status === "completed") {
        const waiters = await readWaiters();
        await writeWaiters(waiters.filter((w) => w.waiterId !== waiterId));
        return { kind: "done", result: existing.result };
      }
      const waiters = await readWaiters();
      if (!isHead(waiters, waiterId)) return null;
      const t = now();
      for (let i = 0; i < limit; i += 1) {
        const slot = await readSlot(i);
        if (slot && slot.until > t) continue;
        const leaseId = crypto.randomUUID();
        await writeSlot(i, { leaseId, until: t + leaseMs });
        await writeWaiters(waiters.filter((w) => w.waiterId !== waiterId));
        await writeTask({
          id: taskId,
          stage,
          status: "running",
          priority,
          leaseId,
          leaseUntil: t + leaseMs,
        });
        return { kind: "slot", index: i, leaseId };
      }
      return null;
    });
  };

  const enqueue = async (waiter: Waiter): Promise<void> => {
    await withLock(async () => {
      const waiters = await readWaiters();
      waiters.push(waiter);
      await writeWaiters(waiters);
    });
  };

  const dequeue = async (waiterId: string): Promise<void> => {
    await withLock(async () => {
      const waiters = await readWaiters();
      await writeWaiters(waiters.filter((w) => w.waiterId !== waiterId));
    });
  };

  return {
    async run<T>(runOpts: CoordinatorRunOptions<T>): Promise<T> {
      const priority = runOpts.priority ?? "batch";
      const waiterId = crypto.randomUUID();
      await enqueue({ waiterId, taskId: runOpts.id, priority, at: now() });
      let slot: { index: number; leaseId: string } | null = null;
      let beat: ReturnType<typeof setInterval> | undefined;
      try {
        for (;;) {
          if (runOpts.signal?.aborted) throw cancelled(runOpts.signal.reason);
          const existing = await readTask(runOpts.id);
          if (existing?.status === "completed") {
            await dequeue(waiterId);
            return existing.result as T;
          }
          const claimed = await claimWork(waiterId, runOpts.id, runOpts.stage, priority);
          if (claimed?.kind === "done") return claimed.result as T;
          if (claimed?.kind === "slot") {
            slot = { index: claimed.index, leaseId: claimed.leaseId };
            break;
          }
          await sleep(pollMs, runOpts.signal);
        }

        const leaseId = slot.leaseId;

        if (liveClock) {
          beat = setInterval(() => {
            void withLock(async () => {
              const current = await readTask(runOpts.id);
              if (current?.leaseId !== leaseId) return;
              await writeTask({ ...current, leaseUntil: now() + leaseMs });
              await writeSlot(slot!.index, { leaseId, until: now() + leaseMs });
            });
          }, Math.max(10, Math.floor(leaseMs / 3)));
        }

        let value: T;
        try {
          value = await runOpts.build();
        } catch (error) {
          if (isCancelledError(error) || runOpts.signal?.aborted) throw cancelled(runOpts.signal?.reason);
          throw error;
        }

        await withLock(async () => {
          const current = await readTask(runOpts.id);
          if (current?.leaseId !== leaseId) throw new AbandonedError();
          await writeTask({
            ...current,
            status: "completed",
            leaseId: null,
            leaseUntil: 0,
            result: value,
          });
        });
        return value;
      } finally {
        if (beat) clearInterval(beat);
        await dequeue(waiterId);
        if (slot) await freeSlot(slot.index, slot.leaseId);
      }
    },
  };
}

function cancelled(reason?: unknown): CancelledError {
  const error = new CancelledError();
  if (reason instanceof Error) error.cause = reason;
  return error;
}
