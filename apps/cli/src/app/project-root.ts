import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PROJECT_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ProjectRuntime = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
  onJevDisabled?: () => void | Promise<void>;
};

type ProjectRuntimeFactory = (opts: {
  id: string;
  dir: string;
  prefix: string;
}) => Promise<ProjectRuntime>;

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("não encontrado");
}

function projectRequest(url: string | undefined): { id: string; prefix: string; rest: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "/", "http://localhost");
  } catch {
    return null;
  }
  const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
  if (!match || !PROJECT_ID_PATTERN.test(match[1]!)) return null;
  if (match[2]?.startsWith("//")) return null;
  const prefix = `/projects/${match[1]}`;
  return { id: match[1]!, prefix, rest: `${match[2] ?? "/"}${parsed.search}` };
}

async function isProjectDirectory(root: string, id: string): Promise<boolean> {
  const dir = resolve(root, id);
  if (dirname(dir) !== root) return false;
  const project = await lstat(dir).catch(() => null);
  if (!project?.isDirectory()) return false;
  const manifest = await lstat(join(dir, "project.json")).catch(() => null);
  return Boolean(manifest?.isFile());
}

/** Registro dos runtimes de Montagem que vivem numa mesma Raiz. */
export function createProjectRuntimeRegistry(opts: {
  projectsRoot: string;
  createRuntime: ProjectRuntimeFactory;
}) {
  const root = resolve(opts.projectsRoot);
  const runtimes = new Map<string, Promise<ProjectRuntime | null>>();

  async function runtimeFor(id: string, prefix: string): Promise<ProjectRuntime | null> {
    const existing = runtimes.get(id);
    if (existing) return existing;
    const created = (async (): Promise<ProjectRuntime | null> => {
      if (!await isProjectDirectory(root, id)) return null;
      const dir = resolve(root, id);
      return opts.createRuntime({ id, dir, prefix });
    })().catch((error: unknown) => {
      runtimes.delete(id);
      throw error;
    });
    runtimes.set(id, created);
    const runtime = await created;
    if (!runtime) runtimes.delete(id);
    return runtime;
  }

  return {
    async isProjectPath(url: string | undefined): Promise<boolean> {
      const route = projectRequest(url);
      return route !== null && await isProjectDirectory(root, route.id);
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const route = projectRequest(req.url);
      if (!route) {
        if ((req.url ?? "/").startsWith("/projects/")) notFound(res);
        return (req.url ?? "/").startsWith("/projects/");
      }
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
    },
    async notifyJevDisabled(): Promise<void> {
      const loaded = await Promise.all([...runtimes.values()]);
      await Promise.all(loaded.filter((runtime): runtime is ProjectRuntime => runtime !== null)
        .map((runtime) => runtime.onJevDisabled?.()));
    },
    async close(): Promise<void> {
      const active = [...runtimes.values()];
      runtimes.clear();
      await Promise.all((await Promise.all(active)).filter((runtime): runtime is ProjectRuntime => runtime !== null).map((runtime) => runtime.close()));
    },
  };
}
