import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectRuntimeContext, resourceLedgerForProject } from "./resource-ledger.ts";

export type ProjectState = "ativo" | "entregue" | "arquivado" | "elegível";
export type ProjectLifecycle = {
  state: ProjectState;
  enteredAt: Partial<Record<ProjectState, number>>;
  /** Revisão coberta pela confirmação; ausente somente em dados antigos. */
  revision?: number;
};
type ProjectRevision = { revision?: number; finalApprovedRevision?: number | null };
export const PROJECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function retentionMs(env: Record<string, string | undefined> = process.env): number {
  const days = Number(env.DECUPA_PROJECT_RETENTION_DAYS);
  return Number.isFinite(days) && days >= 0 && env.DECUPA_PROJECT_RETENTION_DAYS?.trim() ? days * 86_400_000 : PROJECT_RETENTION_MS;
}
export function validateLifecycle(value: unknown): ProjectLifecycle | undefined {
  if (value === undefined) return undefined;
  const life = value as ProjectLifecycle;
  if (!life || !["ativo", "entregue", "arquivado", "elegível"].includes(life.state) || !life.enteredAt || typeof life.enteredAt !== "object"
    || !Number.isFinite(life.enteredAt[life.state]) || Object.values(life.enteredAt).some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)
    || (life.revision !== undefined && (!Number.isSafeInteger(life.revision) || life.revision < 0))) throw new Error("ciclo de vida inválido");
  return { ...life, enteredAt: { ...life.enteredAt } };
}
export function transitionLifecycle(current: ProjectLifecycle, state: ProjectState, now = Date.now(), revision = current.revision): ProjectLifecycle {
  return current.state === state && current.revision === revision ? current : { state, enteredAt: { ...current.enteredAt, [state]: now }, ...(revision !== undefined ? { revision } : {}) };
}
async function projectRevision(dir: string): Promise<ProjectRevision> {
  try { return JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as ProjectRevision; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
export async function deriveLifecycle(dir: string, current?: ProjectLifecycle, opts: {
  now?: () => number; busy?: boolean; env?: Record<string, string | undefined>; project?: ProjectRevision;
} = {}): Promise<ProjectLifecycle> {
  opts = { ...projectRuntimeContext(dir), ...opts };
  const now = (opts.now ?? Date.now)();
  const project = opts.project ?? await projectRevision(dir);
  let life = current;
  const revision = project.revision;
  if (life && life.state !== "arquivado" && (life.state === "entregue" || life.state === "elegível")
    && revision !== undefined && ((life.revision !== undefined && life.revision !== revision) || project.finalApprovedRevision !== revision)) {
    return transitionLifecycle(life, "ativo", now, revision);
  }
  if (!life || life.state === "ativo") {
    const created = await stat(join(dir, "project.json")).then(s => s.birthtimeMs || s.mtimeMs, () => now);
    life ??= { state: "ativo", enteredAt: { ativo: created } };
    const revisions = await readdir(join(dir, "exports")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    let delivered: number | undefined;
    for (const rev of revisions.filter(r => /^\d+$/.test(r))) {
      // Legado só herda entrega confirmada da revisão aprovada atual.
      if (revision !== undefined && (Number(rev) !== revision || project.finalApprovedRevision !== revision)) continue;
      const path = join(dir, "exports", rev, "verificacao.json");
      try {
        const verification = JSON.parse(await readFile(path, "utf8")) as { status?: string; revision?: number; confirmadaEm?: string };
        if (verification.status !== "confirmada" || (revision !== undefined && verification.revision !== revision)) continue;
        const timestamp = Date.parse(verification.confirmadaEm ?? "");
        const at = Number.isFinite(timestamp) ? timestamp : (await stat(path)).mtimeMs;
        delivered = Math.max(delivered ?? 0, at);
      } catch { /* Uma confirmação ilegível não comprova uma entrega. */ }
    }
    if (delivered !== undefined) life = transitionLifecycle(life, "entregue", delivered, revision);
  }
  const busy = opts.busy || await resourceLedgerForProject(dir).hasWork(dir);
  if ((busy || now < (life.enteredAt.entregue ?? now) + retentionMs(opts.env)) && life.state === "elegível") return transitionLifecycle(life, "entregue", life.enteredAt.entregue ?? now, life.revision);
  if (!busy && life.state === "entregue" && now >= (life.enteredAt.entregue ?? now) + retentionMs(opts.env)) return transitionLifecycle(life, "elegível", (life.enteredAt.entregue ?? now) + retentionMs(opts.env));
  return life;
}
