import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { publishAtomic } from "@decupa/cache";
import { withProjectWrite } from "./assembly/store.ts";
import { deriveLifecycle, retentionMs, validateLifecycle, type ProjectLifecycle } from "./project-lifecycle.ts";
import { CleanedResourceError, derivativeKey, mediaKey, projectRuntimeContext, resourceLedgerForProject, ResourceLedger } from "./resource-ledger.ts";

export type CleanupOptions = { ledger?: ResourceLedger; now?: () => number; env?: Record<string, string | undefined> };
type Item = { path: string; kind: string; bytes: number; recoverableBytes: number; identity: string };
export type CleanupPlan = {
  planId: string; projectDir: string; eligible: boolean; cleaned: boolean; lifecycle: ProjectLifecycle; expiresAt?: number;
  items: Item[]; preserved: { path: string; reason: string }[]; recoverableBytes: number; warning?: string;
  resources: string[];
};
type Project = { revision?: number; finalApprovedRevision?: number; lifecycle?: ProjectLifecycle; preparation?: { status?: string }; assembly?: { sources?: { sha256: string; path?: string; name?: string }[] } };
type Transaction = { version: 1; id: string; projectDir: string; state: "staging" | "committed"; resources: string[]; items: Item[] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function info(path: string) { return lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }); }
async function names(path: string) { return readdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }); }
function within(dir: string, path: string) { const rel = relative(dir, path); return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); }
/** Todos os ancestrais são reais; nunca segue links para fora do Projeto. */
async function safePath(dir: string, path: string): Promise<boolean> {
  if (!within(dir, path) || !(await info(dir))?.isDirectory()) return false;
  let current = dir;
  for (const component of relative(dir, path).split(sep)) {
    current = join(current, component); const entry = await info(current);
    if (entry?.isSymbolicLink()) return false;
  }
  return true;
}
function isOwned(ledger: ResourceLedger, dir: string) { return ledger.projectDir ? dir === ledger.projectDir : ledger.projectsRoot ? dirname(dir) === ledger.projectsRoot : dir === ledger.root; }
function permittedCleanupPath(dir: string, path: string): boolean {
  if (!within(dir, path)) return false;
  const rel = relative(dir, path).split(sep).join("/");
  return /^(?:imports\/.+|media\/[a-f0-9]{64}\/.+|analysis\/[a-f0-9]{64}\/.+|preview-cache\/[a-f0-9]{64}\/.+|\.decupa\/metrics\/[^/]+\.jsonl|exports\/\d+\/.+)$/.test(rel);
}
function protectedOriginal(dir: string, path: string): boolean {
  return !within(join(dir, "imports"), path);
}
/** Ponto único da política: o acervo fica preservado, inclusive sem Projeto. */
function isLibraryPath(ledger: ResourceLedger, path: string) { return within(join(ledger.root, "pool"), path); }
const identity = (s: NonNullable<Awaited<ReturnType<typeof info>>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`;
async function buildPlan(dir: string, ledger: ResourceLedger, opts: CleanupOptions): Promise<CleanupPlan> {
  await ledger.references("cleanup:completeness", dir);
  const raw = await readFile(join(dir, "project.json"), "utf8"); const project = JSON.parse(raw) as Project;
  if (!project || !Array.isArray(project.assembly?.sources)) throw new Error("Projeto de montagem inválido para limpeza");
  const busy = project.preparation?.status === "running" || await ledger.hasWork(dir)
    || (ledger.root !== dir && await new ResourceLedger(dir).hasWork(dir));
  const lifecycle = await deriveLifecycle(dir, validateLifecycle(project.lifecycle), { ...opts, busy, project });
  const cleanupState = await ledger.cleanupState(dir);
  const cleaned = Boolean(project.assembly.sources.length) && project.assembly.sources.every(source => cleanupState.released.includes(mediaKey(source.sha256)));
  const eligible = lifecycle.state === "elegível" && !busy && !cleaned;
  const expiresAt = lifecycle.enteredAt.entregue === undefined ? undefined : lifecycle.enteredAt.entregue + retentionMs(opts.env);
  const items = new Map<string, Item>(); const preserved = new Map<string, string>(); const resources = new Set<string>(cleanupState.resources);
  let deliveries = false;
  const ownership: Record<string, string[]> = {};
  const canRelease = async (key: string) => {
    resources.add(key); const owners = await ledger.references(key); ownership[key] = owners.map(owner => owner.id).sort();
    if (owners.some(owner => owner.projectDir !== dir || owner.kind === "in-progress")) return false;
    if (owners.some(owner => ["export", "delivery", "package"].includes(owner.kind))) deliveries = true;
    return true;
  };
  const add = async (path: string, kind: string, allowed: boolean, reason = "referenciada por outro Projeto ou trabalho") => {
    path = resolve(path);
    if (!await safePath(dir, path)) { preserved.set(path, "caminho externo ou simbólico protegido"); return; }
    const entry = await info(path); if (!entry) return;
    if (entry.isDirectory()) {
      if (kind.startsWith("original") || kind === "journal de métricas") { preserved.set(path, "fonte não é um arquivo; diretório preservado"); return; }
      for (const name of (await names(path)).sort()) await add(join(path, name), kind, allowed, reason);
      return;
    }
    if (!entry.isFile()) return;
    if (!permittedCleanupPath(dir, path)) { preserved.set(path, "caminho protegido"); return; }
    if (!allowed) { preserved.set(path, reason); return; }
    items.set(path, { path, kind, bytes: entry.size, recoverableBytes: 0, identity: identity(entry) });
  };
  for (const source of project.assembly.sources) {
    if (!SHA.test(source.sha256)) throw new Error("SHA de fonte inválido; limpeza bloqueada");
    const key = mediaKey(source.sha256); const allowed = await canRelease(key);
    const pool = join(ledger.root, "pool", source.sha256);
    if (await info(pool)) preserved.set(pool, "preservado pelo acervo");
    if (source.path) {
      const path = resolve(source.path);
      if (isLibraryPath(ledger, path)) preserved.set(path, "preservado pelo acervo");
      else if (protectedOriginal(dir, path)) preserved.set(path, "arquivo da pessoa ou fonte externa preservada");
      else await add(path, "original", allowed);
    }
    const proxy = derivativeKey(source.sha256, "proxy", "proxy.mp4");
    const proxyAllowed = await canRelease(proxy);
    await add(join(dir, "media", source.sha256), "proxy", allowed && proxyAllowed);
    for (const analysis of await names(join(dir, "analysis", source.sha256))) {
      const analysisAllowed = await canRelease(derivativeKey(source.sha256, "analysis", analysis));
      const analysisDir = join(dir, "analysis", source.sha256, analysis);
      for (const file of await names(analysisDir)) {
        const visualAllowed = !file.startsWith("visual-") || await canRelease(derivativeKey(source.sha256, "vision", `${analysis}/${file}`));
        await add(join(analysisDir, file), file.startsWith("visual-") ? "visão" : "análise", allowed && analysisAllowed && visualAllowed);
      }
    }
  }
  for (const revision of await names(join(dir, "exports"))) if (/^\d+$/.test(revision)) {
    const exportDir = join(dir, "exports", revision);
    if (!await safePath(dir, join(exportDir, "timeline.otio"))) continue;
    let timeline: unknown;
    try { timeline = JSON.parse(await readFile(join(exportDir, "timeline.otio"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("timeline da entrega ilegível; limpeza bloqueada"); }
    const manifest = JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf8")) as { sources?: Record<string, string> };
    const metadataNames = new Set(["timeline.otio", "manifest.json", "verificacao.json", "reference.mp4", "handoff.json", "handoff.md", "importar-no-resolve.txt", "legendas.vtt", "legendas.srt"]);
    const visit = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.OTIO_SCHEMA === "ExternalReference.1" && typeof record.target_url === "string") {
        const path = record.target_url.startsWith("file:") ? fileURLToPath(record.target_url) : resolve(exportDir, record.target_url);
        const sourceId = (record.metadata as { decupa?: { sourceId?: string } } | undefined)?.decupa?.sourceId;
        const sha = sourceId ? manifest.sources?.[sourceId] : undefined;
        if (within(exportDir, path) && !metadataNames.has(relative(exportDir, path)) && sha && SHA.test(sha)) await add(path, "original da entrega", await canRelease(mediaKey(sha)));
      }
      for (const child of Object.values(record)) if (typeof child === "object") await visit(child);
    };
    await visit(timeline);
  }
  for (const key of await names(join(dir, "preview-cache"))) if (SHA.test(key)) {
    const allowed = await canRelease(`preview:${dir}:${key}`);
    await add(join(dir, "preview-cache", key), "preview-cache", allowed);
  }
  for (const file of await names(join(dir, ".decupa", "metrics"))) if (file.endsWith(".jsonl")) await add(join(dir, ".decupa", "metrics", file), "journal de métricas", true);
  const sorted = [...items.values()].sort((a, b) => a.path.localeCompare(b.path));
  const inodes = new Map<string, { size: number; links: number; items: Item[] }>();
  for (const item of sorted) {
    const entry = await info(item.path); if (!entry || identity(entry) !== item.identity) throw new Error("arquivo mudou durante o plano; revise novamente");
    const key = `${entry.dev}:${entry.ino}`; const old = inodes.get(key);
    inodes.set(key, { size: entry.size, links: entry.nlink, items: [...(old?.items ?? []), item] });
  }
  let recoverableBytes = 0;
  for (const inode of inodes.values()) {
    if (inode.items.length < inode.links) {
      for (const item of inode.items) if (item.kind === "original da entrega") {
        items.delete(item.path); preserved.set(item.path, "alias da entrega preservado: outro hardlink mantém a mídia; remoção não recuperaria espaço");
      }
    } else {
      inode.items[0]!.recoverableBytes = inode.size;
      recoverableBytes += inode.size;
    }
  }
  const removable = sorted.filter(item => items.has(item.path));
  const plan = { projectDir: dir, eligible, cleaned, lifecycle, ...(expiresAt !== undefined ? { expiresAt } : {}), items: removable,
    preserved: [...preserved].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path)), recoverableBytes,
    ...(deliveries && removable.some(item => item.kind.startsWith("original")) ? { warning: "As timelines entregues no Resolve e os pacotes apontam para estes arquivos e ficarão offline se as fontes forem removidas. Preserve uma cópia antes de confirmar." } : {}), resources: [...resources].sort() };
  return { ...plan, planId: hash(JSON.stringify({ raw, plan, ownership })) };
}
export async function planProjectCleanup(projectDir: string, options: CleanupOptions = {}): Promise<CleanupPlan> {
  const dir = resolve(projectDir); const ledger = options.ledger ?? resourceLedgerForProject(dir);
  const opts = { ...projectRuntimeContext(dir), ...options };
  if (!isOwned(ledger, dir)) throw new Error("Projeto fora do escopo autorizado do ledger");
  await ledger.reconcile(); // Nunca usa o snapshot restaurado por um close cancelado.
  return ledger.withCleanupLock(async () => buildPlan(dir, ledger, opts));
}
export async function planProjectCleanupBatch(projectDirs: string[], options: CleanupOptions & { ledger: ResourceLedger }): Promise<({ projectDir: string; plan: CleanupPlan } | { projectDir: string; error: string })[]> {
  const { ledger } = options;
  const dirs = projectDirs.map(dir => resolve(dir));
  if (dirs.some(dir => !isOwned(ledger, dir))) throw new Error("Projeto fora do escopo autorizado do ledger");
  await ledger.reconcile();
  return ledger.withCleanupLock(async () => {
    const plans = [];
    for (const dir of dirs) {
      try { plans.push({ projectDir: dir, plan: await buildPlan(dir, ledger, { ...projectRuntimeContext(dir), ...options }) }); }
      catch (error) { plans.push({ projectDir: dir, error: message(error) }); }
    }
    return plans;
  });
}
function transactionsDir(ledger: ResourceLedger) { return join(ledger.root, ".decupa", "cleanup-transactions"); }
function transactionPath(ledger: ResourceLedger, dir: string) { return join(transactionsDir(ledger), `${hash(dir)}.json`); }
function trashPath(dir: string, id: string, index: number) { return join(dir, ".decupa", "cleanup-trash", id, String(index)); }
async function saveTransaction(path: string, value: Transaction) { await publishAtomic(path, JSON.stringify(value) + "\n", { durable: true }); }
function validateTransaction(tx: Transaction): void {
  if (!tx || tx.version !== 1 || typeof tx.projectDir !== "string" || !/^[a-f0-9-]{36}$/.test(tx.id) || !Array.isArray(tx.items) || !Array.isArray(tx.resources)
    || tx.resources.some(key => typeof key !== "string") || !["staging", "committed"].includes(tx.state)
    || tx.items.some(item => !item || typeof item.path !== "string" || !permittedCleanupPath(resolve(tx.projectDir), item.path))) throw new Error("transação de limpeza inválida");
}
async function recover(ledger: ResourceLedger, tx: Transaction, path: string, release: (dir: string, resources: string[]) => Promise<void>) {
  const dir = resolve(tx.projectDir);
  if (!isOwned(ledger, dir)) return;
  validateTransaction(tx);
  if (!await info(dir)) {
    if (tx.state === "committed") await release(dir, tx.resources);
    await rm(path, { force: true });
    return;
  }
  if (!await safePath(dir, trashPath(dir, tx.id, 0))) throw new Error("quarentena simbólica; limpeza bloqueada");
  for (const item of tx.items) if (typeof item.path !== "string" || !permittedCleanupPath(dir, item.path)) throw new Error("caminho de limpeza inválido");
  if (tx.state === "committed") await release(dir, tx.resources);
  for (let i = 0; i < tx.items.length; i++) {
    const item = tx.items[i]!; const trash = trashPath(dir, tx.id, i);
    if (!await safePath(dir, item.path) || !permittedCleanupPath(dir, item.path)) throw new Error("caminho de limpeza inválido");
    if (!await info(trash)) continue;
    if (tx.state === "staging") {
      if (await info(item.path)) throw new Error("destino de restauração ocupado; limpeza bloqueada");
      await rename(trash, item.path);
    } else await rm(trash);
  }
  await rm(join(dir, ".decupa", "cleanup-trash", tx.id), { recursive: true, force: true });
  await rm(path, { force: true });
}
export async function reconcileProjectCleanups(ledger: ResourceLedger, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const failures: string[] = [];
  for (const file of await names(transactionsDir(ledger))) {
    opts.signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    try {
      const path = join(transactionsDir(ledger), file); const tx = JSON.parse(await readFile(path, "utf8")) as Transaction;
      if (!isOwned(ledger, resolve(tx.projectDir))) continue;
      const reconcile = () => ledger.withPublicationLock(() => ledger.withCleanupLock(async release => {
        opts.signal?.throwIfAborted();
        // Outro boot pode ter concluído a transação enquanto aguardávamos os locks.
        const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (current === null) return;
        const latest = JSON.parse(current) as Transaction;
        if (latest.projectDir !== tx.projectDir) throw new Error("escopo da transação de limpeza mudou");
        validateTransaction(latest);
        await recover(ledger, latest, path, release);
      }));
      if (await info(tx.projectDir)) await withProjectWrite(tx.projectDir, reconcile);
      else await reconcile();
    } catch (error) {
      if (opts.signal?.aborted && error === opts.signal.reason) throw error;
      failures.push(`${file}: ${message(error)}`);
    }
  }
  if (failures.length) throw new CleanedResourceError(`limpeza interrompida: ${failures.join("; ")}`);
}
export async function confirmProjectCleanup(projectDir: string, confirmation: { planId: string; confirmed: boolean; acknowledgeOffline?: boolean }, options: CleanupOptions = {}): Promise<CleanupPlan> {
  if (confirmation.confirmed !== true) throw new Error("confirmação explícita necessária");
  const dir = resolve(projectDir); const ledger = options.ledger ?? resourceLedgerForProject(dir); const opts = { ...projectRuntimeContext(dir), ...options };
  if (!isOwned(ledger, dir)) throw new Error("Projeto fora do escopo autorizado do ledger");
  await ledger.reconcile();
  const result = await withProjectWrite(dir, () => ledger.withPublicationLock(() => ledger.withCleanupLock(async release => {
    if (await info(transactionPath(ledger, dir))) throw new Error("limpeza interrompida; reinicie para reconciliar");
    const plan = await buildPlan(dir, ledger, opts);
    if (!plan.eligible) throw new Error("Projeto não elegível para limpeza");
    if (plan.planId !== confirmation.planId) throw new Error("plano mudou; revise e confirme novamente");
    if (plan.warning && confirmation.acknowledgeOffline !== true) throw new Error("confirme o aviso de arquivos offline");
    const tx: Transaction = { version: 1, id: randomUUID(), projectDir: dir, state: "staging", resources: plan.resources, items: plan.items };
    const path = transactionPath(ledger, dir);
    if (!await safePath(dir, trashPath(dir, tx.id, 0))) throw new Error("quarentena inválida");
    for (const item of plan.items) {
      const entry = await info(item.path);
      if (!await safePath(dir, item.path) || !entry || identity(entry) !== item.identity) throw new Error("arquivo mudou; revise o plano");
    }
    await mkdir(dirname(trashPath(dir, tx.id, 0)), { recursive: true });
    try {
      await saveTransaction(path, tx);
      for (let i = 0; i < plan.items.length; i++) {
        const item = plan.items[i]!; const entry = await info(item.path);
        if (!await safePath(dir, item.path) || !entry || identity(entry).split(":").slice(0, 4).join(":") !== item.identity.split(":").slice(0, 4).join(":")) throw new Error("arquivo mudou; limpeza interrompida");
        await rename(item.path, trashPath(dir, tx.id, i));
      }
    } catch (error) {
      try { await recover(ledger, tx, path, release); }
      catch { /* O journal conserva os recursos protegidos até a reconciliação. */ }
      throw error;
    }
    tx.state = "committed"; await saveTransaction(path, tx);
    await recover(ledger, tx, path, release);
    return plan;
  })));
  await ledger.pruneDeadDescriptors().catch(() => {});
  return result;
}
export function cleanupError(error: unknown) { return message(error); }
