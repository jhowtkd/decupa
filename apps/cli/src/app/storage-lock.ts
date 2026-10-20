import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const PROCESS_SESSION = randomUUID();

/** Serializa escritores cooperantes também entre processos. */
export async function withStorageLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${PROCESS_SESSION}:${randomUUID()}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const file = await open(path, "wx");
      try { await file.writeFile(token); } finally { await file.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8").catch(() => "");
      const pid = Number(owner.split(":")[0]);
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
        if (pid === process.pid && owner.split(":")[1] !== PROCESS_SESSION) alive = false;
      } else alive = Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now()) < 30_000;
      if (!alive && await readFile(path, "utf8").catch(() => null) === owner) await rm(path, { force: true });
      if (Date.now() >= deadline) throw new Error("outro processo mantém o ledger ocupado");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try { return await fn(); }
  finally { if (await readFile(path, "utf8").catch(() => null) === token) await rm(path, { force: true }); }
}

/** I/O independente com limite, conservando a ordem dos resultados. */
export async function mapDisk<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []; let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(32, items.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }));
  const failed = workers.find(worker => worker.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}
