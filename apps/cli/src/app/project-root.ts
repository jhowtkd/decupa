import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// O id é um nome de pasta, não um identificador de linguagem: espaços, acentos
// e pontuação são válidos. O roteador já separa o primeiro componente; aqui
// ficam somente as proteções que impedem sair da Raiz de Projetos.
export const PROJECT_ID_PATTERN = /^(?!\.{1,2}$)(?!.*[\\/\0])[\s\S]+$/u;

type ProjectRuntime = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
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

/** Registro dos runtimes de Projetos que vivem numa mesma Raiz. */
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

  return {
    async isProjectPath(url: string | undefined): Promise<boolean> {
      const route = projectRequest(url);
      return route !== null && await projectKind(root, route.id) !== null;
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const route = projectRequest(req.url);
      if (!route) {
        if ((req.url ?? "/").startsWith("/projects/")) notFound(res);
        return (req.url ?? "/").startsWith("/projects/");
      }
      if (route.needsSlash && await projectKind(root, route.id) !== null) {
        res.writeHead(308, { location: `${route.prefix}/${route.search}`, "cache-control": "no-store" });
        res.end();
        return true;
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
      const loaded = await Promise.all(runtimes.values());
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
