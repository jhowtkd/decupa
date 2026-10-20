import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { publishAtomic } from "@decupa/cache";
import { processAlive } from "./space.ts";
import { mapDisk, PROCESS_SESSION, withStorageLock } from "./storage-lock.ts";

export type ResourceOwner = {
  id: string;
  kind: "project" | "export" | "delivery" | "package" | "in-progress";
  projectDir?: string;
  pid?: number;
  sessionId?: string;
};
type Entry = { owner: ResourceOwner; resources: string[] };
type Snapshot = { version: 1; entries: Entry[]; problems: string[] };
type DiskProject = { assembly?: { sources?: { sha256: string }[] }; path?: string };
type DiskManifest = { sources?: Record<string, string> };
export const mediaKey = (sha: string): string => `media:${sha}`;
export const derivativeKey = (sha: string, kind: "proxy" | "analysis" | "vision", key: string): string => `${kind}:${sha}:${key}`;
const ledgers = new Map<string, ResourceLedger>();
const bindings = new Map<string, string>();
const projectRoots = new Map<string, string>();
const contexts = new Map<string, { now?: () => number; env?: Record<string, string | undefined> }>();
type LedgerProblem = { message: string; previous?: LedgerProblem; cancelled?: boolean };
const incomplete = new Map<string, Map<string, LedgerProblem>>();
const snapshots = new Map<string, { stamp: string; value: Snapshot }>();
const turns = new Map<string, Promise<unknown>>();
const RECONCILING = "reconciliação pendente";
function workAlive(owner: ResourceOwner): boolean {
  return processAlive(owner.pid ?? 0) && !(owner.pid === process.pid && owner.sessionId && owner.sessionId !== PROCESS_SESSION);
}
async function serial<T>(root: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = () => withStorageLock(join(root, ".decupa", "references.lock"), fn, signal);
  const turn = (turns.get(root) ?? Promise.resolve()).then(run, run);
  const tracked = turn.catch(() => undefined); turns.set(root, tracked);
  try { return await turn; } finally { if (turns.get(root) === tracked) turns.delete(root); }
}
async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function json<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function projectResources(project: DiskProject): string[] {
  return [...new Set((project.assembly?.sources ?? []).map(s => mediaKey(s.sha256)))];
}
async function collectProjectResources(dir: string, project: DiskProject, signal?: AbortSignal): Promise<string[]> {
  const resources = projectResources(project);
  for (const source of project.assembly?.sources ?? []) {
    signal?.throwIfAborted();
    for (const key of await directories(join(dir, "analysis", source.sha256))) {
      signal?.throwIfAborted();
      resources.push(derivativeKey(source.sha256, "analysis", key));
      for (const visual of await directories(join(dir, "analysis", source.sha256, key))) {
        if (visual.startsWith("visual-")) resources.push(derivativeKey(source.sha256, "vision", `${key}/${visual}`));
      }
    }
    if (await stat(join(dir, "media", source.sha256, "proxy.mp4")).catch(() => null)) resources.push(derivativeKey(source.sha256, "proxy", "proxy.mp4"));
  }
  return [...new Set(resources)];
}
export class ResourceLedger {
  readonly root: string;
  readonly projectsRoot?: string;
  readonly projectDir?: string;
  private pendingReconciliation?: LedgerProblem;
  constructor(root: string, projectsRoot?: string, projectDir?: string) { this.root = resolve(root); this.projectsRoot = projectsRoot; this.projectDir = projectDir; }
  private get path() { return join(this.root, ".decupa", "references.json"); }
  private get ownersDir() { return join(this.root, ".decupa", "reference-owners"); }
  private ownerPath(id: string) { return join(this.ownersDir, `${createHash("sha256").update(id).digest("hex")}.json`); }
  private async read(): Promise<Snapshot> {
    const info = await stat(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    const stamp = info ? `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}` : "missing";
    const cached = snapshots.get(this.root);
    if (info && cached?.stamp === stamp) return cached.value;
    const indexed = info ? await json<Snapshot>(this.path) : null;
    if (indexed) { snapshots.set(this.root, { stamp, value: indexed }); return indexed; }
    // A ausência do índice nunca significa ausência de detentores: também
    // protege os consumidores locais de análise antes do próximo boot do Hub.
    const entries: Entry[] = []; const problems: string[] = [];
    const files = await readdir(this.ownersDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of files.filter(f => f.endsWith(".json"))) {
      try {
        const entry = await json<Entry>(join(this.ownersDir, file));
        if (entry) entries.push(entry);
      } catch { problems.push(file); }
    }
    return { version: 1, entries, problems };
  }
  private async write(snapshot: Snapshot) {
    await publishAtomic(this.path, JSON.stringify(snapshot, null, 2) + "\n", { durable: true });
    snapshots.delete(this.root);
  }
  markIncomplete(error: unknown, scope = this.projectDir ?? this.projectsRoot ?? this.root): void {
    const problems = incomplete.get(this.root) ?? new Map<string, LedgerProblem>();
    problems.set(resolve(scope), { message: error instanceof Error ? error.message : String(error) });
    incomplete.set(this.root, problems);
  }
  markPendingReconciliation(): void {
    const scope = this.projectDir ?? this.projectsRoot ?? this.root;
    const previous = incomplete.get(this.root)?.get(scope);
    this.markIncomplete(RECONCILING);
    this.pendingReconciliation = incomplete.get(this.root)!.get(scope)!;
    this.pendingReconciliation.previous = previous;
  }
  /** Desfaz somente a marca desta inicialização, nunca um erro ou outro boot. */
  cancelPendingReconciliation(): void {
    const scope = this.projectDir ?? this.projectsRoot ?? this.root;
    const dirty = incomplete.get(this.root);
    if (this.pendingReconciliation) this.pendingReconciliation.cancelled = true;
    if (this.pendingReconciliation && dirty?.get(scope) === this.pendingReconciliation) {
      let previous = this.pendingReconciliation.previous;
      while (previous?.cancelled) previous = previous.previous;
      if (previous) dirty.set(scope, previous); else dirty.delete(scope);
    }
    if (!dirty?.size) incomplete.delete(this.root);
  }
  private finishPendingReconciliation(): void {
    const dirty = incomplete.get(this.root);
    const scope = this.projectDir ?? this.projectsRoot ?? this.root;
    if (this.pendingReconciliation && dirty?.get(scope) === this.pendingReconciliation) dirty.delete(scope);
    if (!dirty?.size) incomplete.delete(this.root);
  }
  private async put(snapshot: Snapshot, entry: Entry) {
    const previous = snapshot.entries.find(e => e.owner.id === entry.owner.id);
    if (previous && JSON.stringify(previous.owner) === JSON.stringify(entry.owner)
      && previous.resources.length === entry.resources.length && previous.resources.every(r => entry.resources.includes(r))) return;
    await publishAtomic(this.ownerPath(entry.owner.id), JSON.stringify(entry) + "\n", { durable: true });
    await this.write({ ...snapshot, entries: [...snapshot.entries.filter(e => e.owner.id !== entry.owner.id), entry] });
  }
  async register(owner: ResourceOwner, resources: string[]): Promise<void> {
    await serial(this.root, async () => this.put(await this.read(), { owner, resources: [...new Set(resources)] }));
  }
  async addResources(owner: ResourceOwner, resources: string[]): Promise<void> {
    await serial(this.root, async () => {
      const snapshot = await this.read();
      const current = snapshot.entries.find(e => e.owner.id === owner.id);
      await this.put(snapshot, { owner, resources: [...new Set([...(current?.resources ?? []), ...resources])] });
    });
  }
  async releaseResources(id: string, resources: string[]): Promise<void> {
    await serial(this.root, async () => {
      const snapshot = await this.read(); const current = snapshot.entries.find(e => e.owner.id === id);
      if (current) await this.put(snapshot, { owner: current.owner, resources: current.resources.filter(r => !resources.includes(r)) });
    });
  }
  /** Libera somente o detentor. Nunca remove mídia ou derivados. */
  async release(id: string): Promise<void> {
    await serial(this.root, async () => {
      const snapshot = await this.read();
      await rm(this.ownerPath(id), { force: true });
      await this.write({ ...snapshot, entries: snapshot.entries.filter(e => e.owner.id !== id) });
    });
  }
  /** Limpeza futura deve abortar se algum manifesto não pôde ser reconciliado. */
  async references(key: string): Promise<ResourceOwner[]> {
    const snapshot = await this.read();
    if (incomplete.get(this.root)?.size) throw new Error(`ledger incompleto: ${[...incomplete.get(this.root)!.values()].map(problem => problem.message).join(", ")}`);
    if (snapshot.problems?.length) throw new Error(`ledger incompleto: ${snapshot.problems.join(", ")}`);
    return snapshot.entries.filter(e => e.resources.includes(key) && (e.owner.kind !== "in-progress" || workAlive(e.owner))).map(e => ({ ...e.owner }));
  }
  async hasWork(dir: string): Promise<boolean> {
    if (incomplete.get(this.root)?.size) return true;
    try {
      const snapshot = await this.read();
      return Boolean(snapshot.problems?.length) || snapshot.entries.some(e => e.owner.kind === "in-progress" && e.owner.projectDir === projectDirectoryForPath(dir) && workAlive(e.owner));
    } catch (error) { this.markIncomplete(error, dir); return true; }
  }
  async syncProject(dir: string, project: DiskProject): Promise<void> {
    await serial(this.root, async () => {
      const resources = await collectProjectResources(dir, project);
      const snapshot = await this.read();
      const owner: ResourceOwner = { id: `project:${resolve(dir)}`, kind: "project", projectDir: resolve(dir) };
      await this.put(snapshot, { owner, resources });
    });
  }
  async reconcile(opts: { signal?: AbortSignal } = {}): Promise<void> {
    const check = () => opts.signal?.throwIfAborted();
    check();
    // Hub vazio não precisa criar metadados. Este atalho só conclui seu
    // próprio marcador pendente; não limpa erros nem publica um snapshot.
    if (!this.projectDir && !await stat(this.path).catch(() => null) && !await stat(this.ownersDir).catch(() => null)
      && (!this.projectsRoot || !(await directories(this.projectsRoot)).length)) {
      check();
      this.finishPendingReconciliation();
      return;
    }
    await serial(this.root, async () => {
      check();
      const dirs = this.projectDir ? [this.projectDir] : this.projectsRoot ? (await directories(this.projectsRoot)).map(id => join(this.projectsRoot!, id)) : [];
      const dirSet = new Set(dirs);
      const previous = await this.read().catch(() => ({ version: 1 as const, entries: [], problems: [] }));
      const owns = (owner: ResourceOwner) => owner.projectDir !== undefined && (
        this.projectDir ? resolve(owner.projectDir) === this.projectDir
          : this.projectsRoot ? dirname(resolve(owner.projectDir)) === this.projectsRoot : false
      );
      // Um boot parcial só substitui o próprio escopo, nunca os outros Hubs.
      const entries = new Map(previous.entries.filter(e => !owns(e.owner)).map(e => [e.owner.id, e]));
      const withinScope = (path: string) => this.projectDir ? resolve(path) === this.projectDir : this.projectsRoot ? resolve(path) === this.projectsRoot || dirname(resolve(path)) === this.projectsRoot : false;
      const problems: string[] = (previous.problems ?? []).filter(path => path.includes("/") && !withinScope(path));
      const files = await readdir(this.ownersDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      const durableOwners = new Map<string, string>();
      await mapDisk(files.filter(f => f.endsWith(".json")), async file => {
        check();
        try {
          const entry = await json<Entry>(join(this.ownersDir, file));
          if (!entry || (entry.owner.kind === "in-progress" && !workAlive(entry.owner))) return;
          if (["project", "export", "delivery", "package"].includes(entry.owner.kind) && owns(entry.owner)) {
            if (!dirSet.has(entry.owner.projectDir ?? "")) { await rm(join(this.ownersDir, file), { force: true }); return; }
          }
          durableOwners.set(entry.owner.id, JSON.stringify(entry));
          entries.set(entry.owner.id, entry);
        } catch { check(); problems.push(file); }
      });
      // A Raiz pode conter muitas pastas que não são Projetos. A descoberta
      // limita I/O concorrente e não serializa duas leituras por pasta alheia.
      const derived = await mapDisk(dirs, async dir => {
        check();
        const found: Entry[] = [];
        try {
          let project = await json<DiskProject>(join(dir, "project.json"));
          if (!project) {
            const cleanup = await json<DiskProject>(join(dir, "source.json"));
            if (cleanup?.path && /^[a-f0-9]{64}$/.test(basename(cleanup.path))) project = { assembly: { sources: [{ sha256: basename(cleanup.path) }] } };
          }
          if (!project) return found;
          bindings.set(resolve(dir), this.root);
          const owner: ResourceOwner = { id: `project:${resolve(dir)}`, kind: "project", projectDir: resolve(dir) };
          found.push({ owner, resources: await collectProjectResources(dir, project, opts.signal) });
          for (const revision of (await directories(join(dir, "exports"))).filter(r => /^\d+$/.test(r))) {
            check();
            const manifest = await json<DiskManifest>(join(dir, "exports", revision, "manifest.json"));
            if (!manifest?.sources) continue;
            const owner: ResourceOwner = { id: `export:${resolve(dir)}:${revision}`, kind: "export", projectDir: resolve(dir) };
            found.push({ owner, resources: [...new Set(Object.values(manifest.sources).map(mediaKey))] });
            const packaged = await json<DiskManifest>(join(dir, "exports", revision, "package-manifest.json"));
            if (packaged?.sources) found.push({
              owner: { id: `package:${resolve(dir)}:${revision}`, kind: "package", projectDir: resolve(dir) },
              resources: [...new Set(Object.values(packaged.sources).map(mediaKey))],
            });
          }
          for (const revision of (await directories(join(dir, "deliveries"))).filter(r => /^\d+$/.test(r))) {
            check();
            const deliveryDir = join(dir, "deliveries", revision);
            const resources = new Set<string>();
            for (const file of (await readdir(deliveryDir)).filter(f => /^request-.*\.json$/.test(f))) {
              check();
              const request = await json<DiskProject>(join(deliveryDir, file));
              if (request) for (const key of projectResources(request)) resources.add(key);
            }
            if (!resources.size) continue;
            const owner: ResourceOwner = { id: `delivery:${resolve(dir)}:${revision}`, kind: "delivery", projectDir: resolve(dir) };
            found.push({ owner, resources: [...resources] });
          }
        } catch { check(); problems.push(dir); }
        return found;
      });
      for (const found of derived) for (const entry of found) entries.set(entry.owner.id, entry);
      // Também persiste detentores derivados: outro escopo consegue refazer
      // o índice inteiro quando o arquivo de índice é perdido.
      await mapDisk([...entries.values()], async entry => {
        check();
        const payload = JSON.stringify(entry);
        if (durableOwners.get(entry.owner.id) !== payload) await publishAtomic(this.ownerPath(entry.owner.id), payload + "\n", { durable: true });
      });
      check();
      await this.write({ version: 1, entries: [...entries.values()], problems });
      const dirty = incomplete.get(this.root);
      for (const scope of dirty?.keys() ?? []) if (withinScope(scope) || (!this.projectDir && !this.projectsRoot && scope === this.root)) dirty!.delete(scope);
      if (!dirty?.size) incomplete.delete(this.root);
    }, opts.signal);
  }
}
export async function initializeResourceLedger(opts: { root: string; projectsRoot?: string; projectDir?: string; now?: () => number; env?: Record<string, string | undefined>; deferReconciliation?: boolean }): Promise<ResourceLedger> {
  const root = resolve(opts.root); const projectsRoot = opts.projectsRoot ? resolve(opts.projectsRoot) : undefined;
  if (projectsRoot) {
    projectRoots.set(projectsRoot, root);
    // Projetos criados antes do boot podem ter um binding local provisório.
    // A raiz explícita do Hub passa a governá-los antes da reconciliação.
    for (const project of bindings.keys()) if (dirname(project) === projectsRoot) bindings.set(project, root);
  }
  contexts.set(root, { now: opts.now, env: opts.env });
  if (opts.projectDir) bindings.set(resolve(opts.projectDir), root);
  const ledger = new ResourceLedger(root, projectsRoot, opts.projectDir ? resolve(opts.projectDir) : undefined); ledgers.set(root, ledger);
  // O boot pode estabelecer os bindings antes de escutar, sem iniciar I/O
  // de descoberta. Até a reconciliação terminar, a limpeza falha fechada.
  if (opts.deferReconciliation) ledger.markPendingReconciliation();
  else try { await ledger.reconcile(); } catch (error) { ledger.markIncomplete(error); }
  return ledger;
}
export function projectDirectoryForPath(dir: string): string {
  const original = resolve(dir); let candidate = original;
  for (;;) {
    if (bindings.has(candidate) || projectRoots.has(dirname(candidate))) return candidate;
    const parent = dirname(candidate); if (parent === candidate) return original;
    candidate = parent;
  }
}
export function storageRootForProject(dir: string): string {
  const project = projectDirectoryForPath(dir);
  return bindings.get(project) ?? projectRoots.get(dirname(project)) ?? project;
}
export function projectRuntimeContext(dir: string) {
  return contexts.get(storageRootForProject(dir)) ?? {};
}
export function resourceLedgerForProject(dir: string): ResourceLedger {
  const project = projectDirectoryForPath(dir); const root = storageRootForProject(project);
  bindings.set(project, root);
  let ledger = ledgers.get(root);
  if (!ledger) { ledger = new ResourceLedger(root); ledgers.set(root, ledger); }
  return ledger;
}
/** O índice derivado não invalida um commit editorial já publicado. */
export async function safeSyncProject(dir: string, project: DiskProject): Promise<void> {
  const ledger = resourceLedgerForProject(dir);
  try { await ledger.syncProject(dir, project); } catch (error) { ledger.markIncomplete(error, dir); }
}
export async function withResourceWork<T>(dir: string, kind: "preparation" | "render" | "export" | "package", sources: { sha256: string }[], fn: () => Promise<T>): Promise<T> {
  const projectDir = projectDirectoryForPath(dir);
  const ledger = resourceLedgerForProject(projectDir); const id = `in-progress:${kind}:${randomUUID()}`;
  try { await ledger.register({ id, kind: "in-progress", projectDir, pid: process.pid, sessionId: PROCESS_SESSION }, sources.map(s => mediaKey(s.sha256))); }
  catch (error) { ledger.markIncomplete(error, projectDir); }
  try { return await fn(); } finally { try { await ledger.release(id); } catch (error) { ledger.markIncomplete(error, projectDir); } }
}
