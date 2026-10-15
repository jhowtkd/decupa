import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { estado, type EditReservation } from "./edit-reservation.ts";

// O id é um nome de pasta, não um identificador de linguagem: espaços, acentos
// e pontuação são válidos. O roteador já separa o primeiro componente; aqui
// ficam somente as proteções que impedem sair da Raiz de Projetos.
export const PROJECT_ID_PATTERN = /^(?!\.{1,2}$)(?!.*[\\/\0])[\s\S]+$/u;

type ProjectRuntime = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
  /** Operação local ou trabalho pesado aguardando a fila global. */
  isBusy?: () => boolean;
  onJevDisabled?: () => void | Promise<void>;
};

type ProjectRuntimeFactory = (opts: {
  id: string;
  dir: string;
  prefix: string;
  kind: "assembly" | "cleanup";
}) => Promise<ProjectRuntime>;

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("não encontrado");
}

function projectRequest(url: string | undefined): { id: string; prefix: string; rest: string; needsSlash: boolean; search: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "/", "http://localhost");
  } catch {
    return null;
  }
  const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!PROJECT_ID_PATTERN.test(id)) return null;
  if (match[2]?.startsWith("//")) return null;
  const prefix = `/projects/${encodeURIComponent(id)}`;
  return {
    id, prefix, rest: `${match[2] ?? "/"}${parsed.search}`,
    needsSlash: match[2] === undefined, search: parsed.search,
  };
}

async function projectKind(root: string, id: string): Promise<"assembly" | "cleanup" | null> {
  // `freeStaleName` usa exatamente este carimbo; `.stale-` no nome original
  // da pasta não transforma o Projeto em lixo histórico.
  if (id.startsWith(".decupa-") && /\.stale-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/.test(id)) return null;
  const dir = resolve(root, id);
  if (dirname(dir) !== root) return null;
  const project = await lstat(dir).catch(() => null);
  if (!project?.isDirectory()) return null;
  const manifest = await lstat(join(dir, "project.json")).catch(() => null);
  if (manifest?.isFile()) return "assembly";
  const source = await lstat(join(dir, "source.json")).catch(() => null);
  return source?.isFile() ? "cleanup" : null;
}

export type ProjectRootEntry = {
  id: string;
  displayName: string;
  flow: "montagem" | "limpeza";
  updatedAt: number;
  reservation: Pick<EditReservation, "nome" | "ultimoSinal"> | null;
  problem?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readRecord(path: string): Promise<{ value: Record<string, unknown> | null; problem?: string }> {
  try {
    const value = record(JSON.parse(await readFile(path, "utf8")) as unknown);
    return value ? { value } : { value: null, problem: "manifesto ilegível" };
  } catch {
    return { value: null, problem: "manifesto ilegível" };
  }
}

async function projectRootEntry(root: string, id: string, now: () => number): Promise<ProjectRootEntry | null> {
  const flow = await projectKind(root, id);
  if (!flow) return null;
  const dir = join(root, id);
  const manifestPath = join(dir, flow === "assembly" ? "project.json" : "source.json");
  const manifest = await readRecord(manifestPath);
  const directory = await stat(dir).catch(() => null);
  const problem = manifest.problem
    ? `${flow === "assembly" ? "project.json" : "source.json"} ilegível`
    : undefined;
  const reservation = await estado(dir, now()).catch(() => null);
  if (flow === "assembly") {
    const assembly = record(manifest.value?.assembly);
    return {
      id,
      displayName: typeof assembly?.name === "string" && assembly.name.trim() ? assembly.name : id,
      flow: "montagem",
      updatedAt: directory?.mtimeMs ?? 0,
      reservation: reservation ? { nome: reservation.nome, ultimoSinal: reservation.ultimoSinal } : null,
      ...(problem ? { problem } : {}),
    };
  }
  const source = manifest.value;
  return {
    id,
    displayName: typeof source?.displayName === "string" && source.displayName.trim() ? source.displayName : id,
    flow: "limpeza",
    updatedAt: directory?.mtimeMs ?? 0,
    reservation: reservation ? { nome: reservation.nome, ultimoSinal: reservation.ultimoSinal } : null,
    ...(problem ? { problem } : {}),
  };
}

/** Lista somente Projetos diretos da Raiz; arquivos auxiliares ficam fora. */
export async function listProjectRootEntries(root: string, now: () => number = Date.now): Promise<ProjectRootEntry[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const projects = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(entry => projectRootEntry(root, entry.name, now)));
  return projects
    .filter((project): project is ProjectRootEntry => project !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

/** Registro dos runtimes de Projetos que vivem numa mesma Raiz. */
export function createProjectRuntimeRegistry(opts: {
  projectsRoot: string;
  createRuntime: ProjectRuntimeFactory;
  now?: () => number;
}) {
  const root = resolve(opts.projectsRoot);
  const now = opts.now ?? Date.now;
  const idleMs = 30 * 60_000;
  const runtimes = new Map<string, Promise<ProjectRuntime | null>>();
  const lastUsed = new Map<string, number>();
  const activeRequests = new Map<string, number>();
  let closed = false;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  const armSweep = (): void => {
    if (closed) return;
    sweepTimer = setTimeout(() => {
      sweep().catch(() => {}).finally(armSweep);
    }, 60_000);
    sweepTimer.unref?.();
  };

  async function sweep(): Promise<void> {
    const expired = [...lastUsed.entries()]
      .filter(([id, used]) => now() - used >= idleMs && !activeRequests.get(id));
    for (const [id] of expired) {
      const pending = runtimes.get(id);
      if (!pending) {
        lastUsed.delete(id);
        continue;
      }
      const runtime = await pending;
      if (!runtime || activeRequests.get(id) || runtime.isBusy?.()) continue;
      // A request may have arrived while close() awaited the runtime promise.
      // Only remove the entry if it is still the one that expired.
      if (runtimes.get(id) !== pending || (lastUsed.get(id) ?? now()) > now() - idleMs) continue;
      runtimes.delete(id);
      lastUsed.delete(id);
      await runtime.close();
    }
  };

  async function runtimeFor(id: string, prefix: string): Promise<ProjectRuntime | null> {
    const existing = runtimes.get(id);
    if (existing) return existing;
    const created = (async (): Promise<ProjectRuntime | null> => {
      const kind = await projectKind(root, id);
      if (!kind) return null;
      const dir = resolve(root, id);
      return opts.createRuntime({ id, dir, prefix, kind });
    })().catch((error: unknown) => {
      runtimes.delete(id);
      throw error;
    });
    runtimes.set(id, created);
    const runtime = await created;
    if (!runtime) runtimes.delete(id);
    return runtime;
  }

  armSweep();
  return {
    async isProjectPath(url: string | undefined): Promise<boolean> {
      const route = projectRequest(url);
      return route !== null && await projectKind(root, route.id) !== null;
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      await sweep();
      const route = projectRequest(req.url);
      if (!route) {
        if ((req.url ?? "/").startsWith("/projects/")) notFound(res);
        return (req.url ?? "/").startsWith("/projects/");
      }
      if (route.needsSlash && await projectKind(root, route.id) !== null) {
        lastUsed.set(route.id, now());
        res.writeHead(308, { location: `${route.prefix}/${route.search}`, "cache-control": "no-store" });
        res.end();
        return true;
      }
      lastUsed.set(route.id, now());
      activeRequests.set(route.id, (activeRequests.get(route.id) ?? 0) + 1);
      try {
        const runtime = await runtimeFor(route.id, route.prefix);
        if (!runtime) {
          notFound(res);
          return true;
        }
        const originalUrl = req.url;
        req.url = route.rest;
        try {
          return await runtime.handle(req, res);
        } finally {
          req.url = originalUrl;
        }
      } finally {
        const active = (activeRequests.get(route.id) ?? 1) - 1;
        if (active > 0) activeRequests.set(route.id, active);
        else activeRequests.delete(route.id);
      }
    },
    async notifyJevDisabled(): Promise<void> {
      const loaded = await Promise.all(runtimes.values());
      await Promise.all(loaded.filter((runtime): runtime is ProjectRuntime => runtime !== null)
        .map((runtime) => runtime.onJevDisabled?.()));
    },
    async close(): Promise<void> {
      closed = true;
      if (sweepTimer) clearTimeout(sweepTimer);
      const active = [...runtimes.values()];
      runtimes.clear();
      lastUsed.clear();
      activeRequests.clear();
      await Promise.all((await Promise.all(active)).filter((runtime): runtime is ProjectRuntime => runtime !== null).map((runtime) => runtime.close()));
    },
  };
}
