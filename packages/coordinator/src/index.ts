import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
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

export type CoordinatorSlotOptions = {
  stage: string;
  priority?: TaskPriority;
  signal?: AbortSignal;
};

export type FileCoordinatorOptions = {
  limit?: number;
  leaseMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Trava sem dono vivo e mais velha que isto é vencida. Padrão: 30 s. */
  staleLockMs?: number;
};

export type FileCoordinator = {
  run<T>(opts: CoordinatorRunOptions<T>): Promise<T>;
  withSlot<T>(opts: CoordinatorSlotOptions, fn: () => Promise<T> | T): Promise<T>;
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
  seenAt: number;
};

type Slot = { leaseId: string; until: number };

type Claim =
  | { kind: "done"; result: unknown }
  | { kind: "slot"; index: number; leaseId: string };

const DEFAULT_LIMIT = 1;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * Waiters que este processo ainda está atendendo, por pasta de fila. Eles estão
 * vivos por definição: um processo lento (lock disputado, timer atrasado no
 * Windows) não pode ser tomado por morto por outro waiter do mesmo processo e
 * perder o lugar na fila. A expiração por heartbeat continua valendo para os
 * waiters de outros processos.
 */
const localWaiters = new Map<string, Set<string>>();

function waiterHeartbeatMs(leaseMs: number): number {
  return Math.max(1, Math.floor(leaseMs / 3));
}

function lockBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY";
}

/** PID vivo nesta máquina? EPERM é processo de outro usuário: vivo. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A trava guarda `<pid> <host>` de quem a criou. Ela é vencida quando o dono
 * morreu (mesma máquina) ou quando está velha demais para uma seção que dura
 * milissegundos (dono em outra máquina, PID ilegível ou reusado).
 */
function lockIsStale(content: string, mtimeMs: number, staleMs: number): boolean {
  if (Date.now() - mtimeMs > staleMs) return true;
  const [rawPid, host] = content.trim().split(/\s+/, 2);
  const pid = Number(rawPid);
  if (!Number.isInteger(pid) || pid <= 0 || host !== hostname()) return false;
  return !pidAlive(pid);
}

export function createFileCoordinator(dir: string, opts: FileCoordinatorOptions = {}): FileCoordinator {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limite do coordenador precisa ser um inteiro >= 1");
  }
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const waiterBeatMs = waiterHeartbeatMs(leaseMs);
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

  /**
   * Remove a trava de um processo que morreu com ela. Sem isto um `.lock`
   * órfão travava para sempre toda transcrição seguinte. Confere de novo o
   * inode e o mtime logo antes de apagar, para não levar a trava nova de
   * quem acabou de pegá-la.
   */
  const clearStaleLock = async (): Promise<void> => {
    const before = await stat(paths.lock).catch(() => null);
    if (!before) return;
    const content = await readFile(paths.lock, "utf8").catch(() => "");
    if (!lockIsStale(content, before.mtimeMs, staleLockMs)) return;
    const again = await stat(paths.lock).catch(() => null);
    if (!again || again.ino !== before.ino || again.mtimeMs !== before.mtimeMs) return;
    await unlink(paths.lock).catch(() => undefined);
  };

  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    await mkdir(dir, { recursive: true });
    for (;;) {
      try {
        const handle = await open(paths.lock, "wx");
        try {
          await handle.writeFile(`${process.pid} ${hostname()}\n`, "utf8");
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (!lockBusy(error)) throw error;
        await clearStaleLock();
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

  const liveHere = localWaiters.get(resolve(dir)) ?? new Set<string>();
  localWaiters.set(resolve(dir), liveHere);

  /**
   * Só ENOENT é fila vazia. Outro erro de leitura (EBUSY/EPERM do Windows
   * durante a troca do arquivo) é tentado de novo: devolver [] faria quem leu
   * regravar a fila só consigo e apagar os demais waiters.
   */
  const readWaitersText = async (): Promise<string | null> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readFile(paths.waiters, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (attempt >= 20) throw error;
        await sleep(pollMs);
      }
    }
  };

  const readWaiters = async (): Promise<Waiter[]> => {
    const text = await readWaitersText();
    if (text === null) return [];
    try {
      const raw = JSON.parse(text) as Waiter[];
      const cutoff = now() - leaseMs * 4;
      return raw
        .map((waiter) => ({
          ...waiter,
          // Waiters antigos não tinham heartbeat; o instante de entrada é o
          // único sinal disponível para lê-los sem quebrar a fila existente.
          seenAt: Number.isFinite(waiter.seenAt) ? waiter.seenAt : waiter.at,
        }))
        .filter((waiter) => waiter.seenAt >= cutoff || liveHere.has(waiter.waiterId));
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

  const refreshWaiter = (waiters: Waiter[], waiter: Waiter, t: number): boolean => {
    const current = waiters.find((candidate) => candidate.waiterId === waiter.waiterId);
    if (!current) {
      // O arquivo pode ter sido perdido ou o registro pode ter expirado
      // durante a espera. Reentra com a ordem original, não como o último.
      waiters.push({ ...waiter, seenAt: t });
      return true;
    }
    if (t - current.seenAt < waiterBeatMs) return false;
    current.seenAt = t;
    return true;
  };

  const claimWork = async (
    waiter: Waiter,
    taskId: string,
    stage: string,
    priority: TaskPriority,
  ): Promise<Claim | null> => {
    return withLock(async () => {
      const existing = await readTask(taskId);
      if (existing?.status === "completed") {
        const waiters = await readWaiters();
        await writeWaiters(waiters.filter((w) => w.waiterId !== waiter.waiterId));
        return { kind: "done", result: existing.result };
      }
      const waiters = await readWaiters();
      const changed = refreshWaiter(waiters, waiter, now());
      if (changed) await writeWaiters(waiters);
      if (!isHead(waiters, waiter.waiterId)) return null;
      const t = now();
      for (let i = 0; i < limit; i += 1) {
        const slot = await readSlot(i);
        if (slot && slot.until > t) continue;
        const leaseId = crypto.randomUUID();
        await writeSlot(i, { leaseId, until: t + leaseMs });
        await writeWaiters(waiters.filter((w) => w.waiterId !== waiter.waiterId));
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

  const claimSlot = async (
    waiter: Waiter,
  ): Promise<{ index: number; leaseId: string } | null> => {
    return withLock(async () => {
      const waiters = await readWaiters();
      const changed = refreshWaiter(waiters, waiter, now());
      if (changed) await writeWaiters(waiters);
      if (!isHead(waiters, waiter.waiterId)) return null;
      const t = now();
      for (let i = 0; i < limit; i += 1) {
        const slot = await readSlot(i);
        if (slot && slot.until > t) continue;
        const leaseId = crypto.randomUUID();
        await writeSlot(i, { leaseId, until: t + leaseMs });
        await writeWaiters(waiters.filter((w) => w.waiterId !== waiter.waiterId));
        return { index: i, leaseId };
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
      const enteredAt = now();
      const waiter = { waiterId, taskId: runOpts.id, priority, at: enteredAt, seenAt: enteredAt };
      liveHere.add(waiterId);
      try {
        await enqueue(waiter);
      } catch (error) {
        liveHere.delete(waiterId);
        throw error;
      }
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
          const claimed = await claimWork(waiter, runOpts.id, runOpts.stage, priority);
          if (claimed?.kind === "done") return claimed.result as T;
          if (claimed?.kind === "slot") {
            slot = { index: claimed.index, leaseId: claimed.leaseId };
            break;
          }
          await sleep(pollMs, runOpts.signal);
        }

        if (runOpts.signal?.aborted) throw cancelled(runOpts.signal.reason);

        const leaseId = slot.leaseId;

        if (liveClock) {
          beat = setInterval(() => {
            void withLock(async () => {
              const current = await readTask(runOpts.id);
              if (current?.leaseId !== leaseId) return;
              await writeTask({ ...current, leaseUntil: now() + leaseMs });
              await writeSlot(slot!.index, { leaseId, until: now() + leaseMs });
            }).catch(() => undefined);
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
        liveHere.delete(waiterId);
        await dequeue(waiterId);
        if (slot) await freeSlot(slot.index, slot.leaseId);
      }
    },
    async withSlot<T>(slotOpts: CoordinatorSlotOptions, fn: () => Promise<T> | T): Promise<T> {
      const priority = slotOpts.priority ?? "batch";
      const waiterId = crypto.randomUUID();
      const enteredAt = now();
      const waiter = { waiterId, taskId: waiterId, priority, at: enteredAt, seenAt: enteredAt };
      liveHere.add(waiterId);
      try {
        await enqueue(waiter);
      } catch (error) {
        liveHere.delete(waiterId);
        throw error;
      }
      let slot: { index: number; leaseId: string } | null = null;
      let beat: ReturnType<typeof setInterval> | undefined;
      try {
        for (;;) {
          if (slotOpts.signal?.aborted) throw cancelled(slotOpts.signal.reason);
          const claimed = await claimSlot(waiter);
          if (claimed) {
            slot = claimed;
            break;
          }
          await sleep(pollMs, slotOpts.signal);
        }

        if (slotOpts.signal?.aborted) throw cancelled(slotOpts.signal.reason);

        const leaseId = slot.leaseId;
        if (liveClock) {
          beat = setInterval(() => {
            void withLock(async () => {
              const current = await readSlot(slot!.index);
              if (current?.leaseId !== leaseId) return;
              await writeSlot(slot!.index, { leaseId, until: now() + leaseMs });
            }).catch(() => undefined);
          }, Math.max(10, Math.floor(leaseMs / 3)));
        }

        try {
          return await fn();
        } catch (error) {
          if (isCancelledError(error) || slotOpts.signal?.aborted) {
            throw cancelled(slotOpts.signal?.reason);
          }
          throw error;
        }
      } finally {
        if (beat) clearInterval(beat);
        liveHere.delete(waiterId);
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
