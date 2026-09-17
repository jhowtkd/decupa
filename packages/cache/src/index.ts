import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

export async function publishAtomic(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, path);
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
