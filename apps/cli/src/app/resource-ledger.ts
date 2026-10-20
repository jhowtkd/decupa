import { withProjectSourceImports } from "./project-source-import.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
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
type Snapshot = { version: 1; entries: Entry[]; problems: string[]; releases?: Record<string, string[]> };
export class CleanedResourceError extends Error {}
type DiskProject = { assembly?: { sources?: { sha256: string; path?: string }[] }; path?: string };
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
const publicationTurns = new Map<string, Promise<unknown>>();
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
  for (const key of await directories(join(dir, "preview-cache"))) if (/^[a-f0-9]{64}$/.test(key)) resources.push(`preview:${resolve(dir)}:${key}`);
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
    const releases = await this.readReleases();
    return { version: 1, entries: entries.map(entry => ({ ...entry, resources: entry.resources.filter(key => !releases[entry.owner.projectDir ?? ""]?.includes(key)) })), problems, releases };
  }
  private async readReleases(): Promise<Record<string, string[]>> {
    const releases: Record<string, string[]> = {};
    for (const file of await readdir(join(this.root, ".decupa", "resource-releases")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = await json<{ projectDir: string; resources: string[] }>(join(this.root, ".decupa", "resource-releases", file));
      if (!record || typeof record.projectDir !== "string" || !Array.isArray(record.resources) || record.resources.some(key => typeof key !== "string")) throw new Error("registro de limpeza ilegível");
      releases[record.projectDir] = record.resources;
    }
    return releases;
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
  /** Publicação editorial e limpeza compartilham esta fronteira, sempre antes do references.lock. */
  async withPublicationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => withStorageLock(join(this.root, ".decupa", "publications.lock"), fn);
    const turn = (publicationTurns.get(this.root) ?? Promise.resolve()).then(run, run);
    const tracked = turn.catch(() => undefined); publicationTurns.set(this.root, tracked);
    try { return await turn; } finally { if (publicationTurns.get(this.root) === tracked) publicationTurns.delete(this.root); }
  }
  async newProjectSources(dir: string, project: DiskProject): Promise<{ sha256: string; path?: string }[]> {
    const current = await json<DiskProject>(join(dir, "project.json")).catch((error: unknown) => { if (error instanceof SyntaxError) return null; throw error; });
    return (project.assembly?.sources ?? []).filter(source => !current?.assembly?.sources?.some(old => old.sha256 === source.sha256 && old.path === source.path));
  }
  async assertSourcePublication(dir: string, project: DiskProject): Promise<void> {
    const sources = await this.newProjectSources(dir, project);
    if (!sources.length) return;
    const pending = await this.pendingCleanups();
    const releases = await this.readReleases();
    const canonical = async (path: string): Promise<string> => {
      try { return await realpath(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = dirname(path); return parent === path ? path : join(await canonical(parent), basename(path)); }
    };
    for (const source of sources) {
      if (!source.path) continue;
      const path = await canonical(resolve(source.path));
      for (const tx of pending) if (path.startsWith(`${await canonical(tx.projectDir)}${sep}`)) throw new CleanedResourceError("fonte em limpeza interrompida; reconcilie o Projeto de origem");
      for (const [projectDir, keys] of Object.entries(releases)) if (keys.includes(mediaKey(source.sha256)) && path.startsWith(`${await canonical(projectDir)}${sep}`)
        && !await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; })) {
        throw new CleanedResourceError("fonte removida pela limpeza; escolha uma cópia preservada no acervo");
      }
    }
  }
  async resetProjectRelease(dir: string): Promise<void> {
    await serial(this.root, async () => {
      const snapshot = await this.read(); const releases = { ...snapshot.releases }; delete releases[resolve(dir)];
      await rm(join(this.root, ".decupa", "resource-releases", `${createHash("sha256").update(resolve(dir)).digest("hex")}.json`), { force: true });
      await this.write({ ...snapshot, releases });
    });
  }
  async cleanupState(dir: string): Promise<{ resources: string[]; released: string[] }> {
    await this.references("cleanup:completeness", dir);
    const snapshot = await this.read();
    return { resources: [...new Set(snapshot.entries.filter(entry => entry.owner.projectDir === resolve(dir)).flatMap(entry => entry.resources))], released: [...(snapshot.releases?.[resolve(dir)] ?? [])] };
  }
  private async pendingCleanups(): Promise<{ projectDir: string; resources: string[] }[]> {
    const dir = join(this.root, ".decupa", "cleanup-transactions");
    const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const records: { projectDir: string; resources: string[] }[] = [];
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const tx = await json<{ projectDir: string; resources: string[] }>(join(dir, file));
      if (!tx) continue;
      if (typeof tx.projectDir !== "string" || !Array.isArray(tx.resources) || tx.resources.some(key => typeof key !== "string")) throw new Error("ledger incompleto: transação de limpeza ilegível");
      records.push(tx);
    }
    return records;
  }
  private async assertNoCleanup(opts: { projectDir?: string; resources?: string[]; all?: boolean } = {}): Promise<void> {
    const pending = await this.pendingCleanups();
    if (pending.some(tx => opts.all || tx.projectDir === opts.projectDir || opts.resources?.some(key => tx.resources.includes(key)))) throw new CleanedResourceError("limpeza interrompida ou em andamento; reinicie o Projeto de origem para reconciliar");
  }
  /** A confirmação usa a mesma exclusão de register/sync/reconcile. */
  async withCleanupLock<T>(fn: (release: (dir: string, resources: string[]) => Promise<void>) => Promise<T>): Promise<T> {
    return serial(this.root, () => fn(async (dir, resources) => {
      const snapshot = await this.read();
      const releases = { ...snapshot.releases, [resolve(dir)]: [...new Set([...(snapshot.releases?.[resolve(dir)] ?? []), ...resources])] };
      await publishAtomic(join(this.root, ".decupa", "resource-releases", `${createHash("sha256").update(resolve(dir)).digest("hex")}.json`), JSON.stringify({ projectDir: resolve(dir), resources: releases[resolve(dir)] }) + "\n", { durable: true });
      const entries = snapshot.entries.map(entry => entry.owner.projectDir === resolve(dir)
        ? { ...entry, resources: entry.resources.filter(key => !resources.includes(key)) } : entry);
      for (const entry of entries.filter(entry => entry.owner.projectDir === resolve(dir))) await publishAtomic(this.ownerPath(entry.owner.id), JSON.stringify(entry) + "\n", { durable: true });
      await this.write({ ...snapshot, entries, releases });
    }));
  }
  async pruneDeadDescriptors(): Promise<void> {
    await serial(this.root, async () => {
      for (const file of await readdir(this.ownersDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
        if (!file.endsWith(".json")) continue;
        const entry = await json<Entry>(join(this.ownersDir, file)).catch(() => null);
        if (entry?.owner.kind === "in-progress" && !workAlive(entry.owner)) await rm(join(this.ownersDir, file), { force: true }).catch(() => {});
      }
      const dir = join(this.root, ".reservations");
      for (const file of await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
        if (!file.endsWith(".json")) continue;
        const owner = await json<{ pid?: number; sessionId?: string }>(join(dir, file)).catch(() => null);
        if (owner && !workAlive({ id: file, kind: "in-progress", ...owner })) await rm(join(dir, file), { force: true }).catch(() => {});
      }
    });
  }
  private async put(snapshot: Snapshot, entry: Entry) {
    const previous = snapshot.entries.find(e => e.owner.id === entry.owner.id);
    if (previous && JSON.stringify(previous.owner) === JSON.stringify(entry.owner)
      && previous.resources.length === entry.resources.length && previous.resources.every(r => entry.resources.includes(r))) return;
    await publishAtomic(this.ownerPath(entry.owner.id), JSON.stringify(entry) + "\n", { durable: true });
    await this.write({ ...snapshot, entries: [...snapshot.entries.filter(e => e.owner.id !== entry.owner.id), entry] });
  }
  async register(owner: ResourceOwner, resources: string[]): Promise<void> {
    await serial(this.root, async () => {
      await this.assertNoCleanup({ projectDir: owner.projectDir, resources });
      const snapshot = await this.read();
      if (owner.projectDir && resources.some(key => snapshot.releases?.[resolve(owner.projectDir!)]?.includes(key))) throw new CleanedResourceError("mídias deste Projeto já foram limpas; crie um novo Projeto para reutilizá-las");
      await this.put(snapshot, { owner, resources: [...new Set(resources)] });
    });
  }
  async addResources(owner: ResourceOwner, resources: string[]): Promise<void> {
    await serial(this.root, async () => {
      await this.assertNoCleanup({ projectDir: owner.projectDir, resources });
      const snapshot = await this.read();
      const current = snapshot.entries.find(e => e.owner.id === owner.id);
      if (owner.projectDir && resources.some(key => snapshot.releases?.[resolve(owner.projectDir!)]?.includes(key))) throw new CleanedResourceError("mídias deste Projeto já foram limpas");
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
  async references(key: string, projectDir?: string): Promise<ResourceOwner[]> {
    await this.assertNoCleanup({ projectDir, resources: [key], all: key === "cleanup:completeness" && !projectDir });
    const snapshot = await this.read();
    if (incomplete.get(this.root)?.size) throw new Error(`ledger incompleto: ${[...incomplete.get(this.root)!.values()].map(problem => problem.message).join(", ")}`);
    if (snapshot.problems?.length) throw new Error(`ledger incompleto: ${snapshot.problems.join(", ")}`);
    return snapshot.entries.filter(e => e.resources.includes(key) && (e.owner.kind !== "in-progress" || workAlive(e.owner))).map(e => ({ ...e.owner }));
  }
  async hasWork(dir: string): Promise<boolean> {
    try { await this.assertNoCleanup({ projectDir: projectDirectoryForPath(dir) }); } catch { return true; }
    if (incomplete.get(this.root)?.size) return true;
    try {
      const snapshot = await this.read();
      if (snapshot.problems?.length) return true;
      const active = snapshot.entries.filter(e => e.owner.kind === "in-progress" && workAlive(e.owner));
      const projectDir = projectDirectoryForPath(dir);
      if (active.some(e => e.owner.projectDir === projectDir)) return true;
      if (!active.length) return false;
      const canonical = await realpath(projectDir).catch(() => projectDir);
      for (const entry of active) if (entry.owner.projectDir && await realpath(entry.owner.projectDir).catch(() => entry.owner.projectDir) === canonical) return true;
      return false;
    } catch (error) { this.markIncomplete(error, dir); return true; }
  }
  async syncProject(dir: string, project: DiskProject): Promise<void> {
    await serial(this.root, async () => {
      const resources = await collectProjectResources(dir, project);
      const snapshot = await this.read();
      const owner: ResourceOwner = { id: `project:${resolve(dir)}`, kind: "project", projectDir: resolve(dir) };
      await this.put(snapshot, { owner, resources: resources.filter(key => !snapshot.releases?.[resolve(dir)]?.includes(key)) });
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
      const previous: Snapshot = await this.read().catch(() => ({ version: 1 as const, entries: [], problems: [] }));
      const owns = (owner: ResourceOwner) => owner.projectDir !== undefined && (
        this.projectDir ? resolve(owner.projectDir) === this.projectDir
          : this.projectsRoot ? dirname(resolve(owner.projectDir)) === this.projectsRoot : false
      );
      // Um boot parcial só substitui o próprio escopo, nunca os outros Hubs.
      const entries = new Map(previous.entries.filter(e => !owns(e.owner)).map(e => [e.owner.id, e]));
      const withinScope = (path: string) => this.projectDir ? resolve(path) === this.projectDir : this.projectsRoot ? resolve(path) === this.projectsRoot || dirname(resolve(path)) === this.projectsRoot : false;
      const problems: string[] = (previous.problems ?? []).filter(path => path.includes("/") && !withinScope(path));
      const files = await readdir(this.ownersDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      const releases = await this.readReleases();
      for (const projectDir of Object.keys(releases)) if (owns({ id: "release", kind: "project", projectDir }) && !await stat(projectDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; })) {
        check();
        await rm(join(this.root, ".decupa", "resource-releases", `${createHash("sha256").update(projectDir).digest("hex")}.json`), { force: true });
        delete releases[projectDir];
      }
      check();
      const durableOwners = new Map<string, string>();
      await mapDisk(files.filter(f => f.endsWith(".json")), async file => {
        check();
        try {
          const entry = await json<Entry>(join(this.ownersDir, file));
          if (!entry || (entry.owner.kind === "in-progress" && !workAlive(entry.owner))) return;
          if (["project", "export", "delivery"].includes(entry.owner.kind) && owns(entry.owner)) {
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
      for (const entry of entries.values()) entry.resources = entry.resources.filter(key => !releases[entry.owner.projectDir ?? ""]?.includes(key));
      // Também persiste detentores derivados: outro escopo consegue refazer
      // o índice inteiro quando o arquivo de índice é perdido.
      await mapDisk([...entries.values()], async entry => {
        check();
        const payload = JSON.stringify(entry);
        if (durableOwners.get(entry.owner.id) !== payload) await publishAtomic(this.ownerPath(entry.owner.id), payload + "\n", { durable: true });
      });
      check();
      await this.write({ version: 1, entries: [...entries.values()], problems, releases });
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
  catch (error) { if (error instanceof CleanedResourceError) throw error; ledger.markIncomplete(error, projectDir); }
  try { return await fn(); } finally { try { await ledger.release(id); } catch (error) { ledger.markIncomplete(error, projectDir); } }
}

/** Protege a publicação e a sincronização posterior, sem converter falha pós-commit em falha editorial. */
export async function withProjectResourcePublication<T>(dir: string, project: DiskProject, publish: () => Promise<T>, opts: { creating?: boolean } = {}): Promise<T> {
  const ledger = resourceLedgerForProject(dir);
  const sources = await ledger.newProjectSources(dir, project);
  // Metadados não dependem da disponibilidade do ledger antes do commit.
  if (!sources.length && !opts.creating) return publish();
  if (!sources.length && opts.creating) {
    const receipt = join(ledger.root, ".decupa", "resource-releases", `${createHash("sha256").update(resolve(dir)).digest("hex")}.json`);
    const exists = await stat(receipt).catch(() => null);
    if (!exists) return publish();
  }
  return ledger.withPublicationLock(async () => {
    await ledger.assertSourcePublication(dir, project);
    if (opts.creating && !await stat(join(dir, "project.json")).catch(() => null)) await ledger.resetProjectRelease(dir);
    return withProjectSourceImports(dir, ledger.root, sources, async owner => {
      const canonicalRoot = await realpath(ledger.root).catch(() => ledger.root);
      if (await realpath(storageRootForProject(owner)).catch(() => storageRootForProject(owner)) === canonicalRoot) return true;
      return Boolean(ledger.projectsRoot && dirname(owner) === await realpath(ledger.projectsRoot).catch(() => ledger.projectsRoot));
    }, publish);
  });
}
