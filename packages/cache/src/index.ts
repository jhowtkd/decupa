import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CancelledError, createLimitedQueue, isCancelledError, type LimitedQueue } from "@decupa/queue";

export type ArtifactStatus = "missing" | "unknown" | "ready";

export type ArtifactInspection = {
  status: ArtifactStatus;
  value?: unknown;
};

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || isCancelledError(error);
}

export async function inspectArtifact(path: string): Promise<ArtifactInspection> {
  try {
    const info = await stat(path);
    if (info.size === 0) return { status: "unknown" };
  } catch {
    return { status: "missing" };
  }
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return { status: "unknown" };
    return { status: "ready", value: JSON.parse(raw) };
  } catch {
    return { status: "unknown" };
  }
}

function replaceBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "EBUSY";
}

export type PublishOptions = {
  /**
   * fsync do temporário antes do rename, e da pasta depois: uma queda de
   * energia logo após publicar não deixa o arquivo vazio ou truncado.
   */
  durable?: boolean;
};

async function writeSynced(path: string, payload: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDir(path: string): Promise<void> {
  // Windows não abre pasta para fsync: best-effort.
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Sem fsync de pasta, o rename já está no journal do sistema de arquivos.
  }
}

export async function publishAtomic(path: string, payload: string, opts: PublishOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const write = opts.durable ? writeSynced : (target: string, text: string) => writeFile(target, text, "utf8");
  try {
    await write(tmp, payload);
    let last: unknown;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        await rename(tmp, path);
        if (opts.durable) await syncDir(dirname(path));
        return;
      } catch (error) {
        last = error;
        if (!replaceBusy(error)) throw error;
        // Windows cannot rename-over a destination that is open (antivirus
        // or a concurrent reader). Overwrite in place, then retry rename.
        try {
          await write(path, payload);
          await unlink(tmp).catch(() => undefined);
          return;
        } catch (writeError) {
          last = writeError;
          if (!replaceBusy(writeError)) throw writeError;
        }
        await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 5));
      }
    }
    throw last;
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export type ArtifactCache = {
  getOrCreate<T>(
    key: string,
    build: () => Promise<T> | T,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
};

export function createArtifactCache(dir: string, queue: LimitedQueue = createLimitedQueue(4)): ArtifactCache {
  return {
    async getOrCreate<T>(
      key: string,
      build: () => Promise<T> | T,
      opts?: { signal?: AbortSignal },
    ): Promise<T> {
      const path = join(dir, `${key}.json`);
      return queue.run(async () => {
        const current = await inspectArtifact(path);
        if (current.status === "ready") return current.value as T;
        if (opts?.signal?.aborted) throw new CancelledError();
        try {
          const value = await build();
          if (opts?.signal?.aborted) throw new CancelledError();
          await publishAtomic(path, `${JSON.stringify(value)}\n`);
          return value;
        } catch (error) {
          if (isCancelled(error, opts?.signal)) throw new CancelledError();
          throw error;
        }
      }, { key, signal: opts?.signal });
    },
  };
}
