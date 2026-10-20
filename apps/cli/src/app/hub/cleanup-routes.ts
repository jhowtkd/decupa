import type { IncomingMessage, ServerResponse } from "node:http";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupError, confirmProjectCleanup, planProjectCleanup, planProjectCleanupBatch } from "../project-cleanup.ts";
import type { ResourceLedger } from "../resource-ledger.ts";
import { PROJECT_ID_PATTERN } from "../project-root.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new Error("pedido excede 16 KiB"); chunks.push(chunk); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pedido inválido");
  return value as Record<string, unknown>;
}
export function createProjectCleanupRoutes(opts: { ledger: ResourceLedger; projectsRoot: string; now?: () => number; env?: Record<string, string | undefined> }) {
  const active = new Set<Promise<unknown>>(); let closed = false;
  const options = { ledger: opts.ledger, now: opts.now, env: opts.env };
  async function project(id: string) {
    if (!PROJECT_ID_PATTERN.test(id)) return null;
    const dir = resolve(opts.projectsRoot, id);
    if (dirname(dir) !== resolve(opts.projectsRoot) || (opts.ledger.projectDir && dir !== opts.ledger.projectDir)) return null;
    const entry = await lstat(dir).catch(() => null);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) return null;
    const manifest = await lstat(join(dir, "project.json")).catch(() => null);
    return manifest?.isFile() && !manifest.isSymbolicLink() ? dir : null;
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const assets: Record<string, [string, string]> = { "/cleanup": ["cleanup.html", "text/html"], "/hub/cleanup.js": ["cleanup.js", "application/javascript"], "/hub/cleanup.css": ["cleanup.css", "text/css"] };
    const asset = assets[url.pathname];
    if (asset) {
      if (req.method !== "GET") { json(res, { error: "método inválido" }, 405); return true; }
      res.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "cache-control": "no-store" }); res.end(await readFile(join(HERE, asset[0]), "utf8")); return true;
    }
    if (!url.pathname.startsWith("/api/cleanup/")) return false;
    if (closed) { json(res, { error: "servidor encerrando" }, 503); return true; }
    try {
      if (url.pathname === "/api/cleanup/projects") {
        if (req.method !== "GET") { json(res, { error: "método inválido" }, 405); return true; }
        const rows = [];
        const ids = opts.ledger.projectDir ? [opts.ledger.projectDir.slice(dirname(opts.ledger.projectDir).length + 1)] : await readdir(opts.projectsRoot);
        const projects = [];
        for (const id of ids) { const dir = await project(id); if (dir) projects.push({ id, dir }); }
        const plans = await planProjectCleanupBatch(projects.map(project => project.dir), options);
        for (const result of plans) {
          const id = projects.find(project => project.dir === result.projectDir)!.id;
          if ("error" in result) { rows.push({ id, name: id, eligible: false, problem: result.error }); continue; }
          const plan = result.plan;
          const data = JSON.parse(await readFile(join(result.projectDir, "project.json"), "utf8")) as { assembly?: { name?: string } };
          rows.push({ id, name: data.assembly?.name ?? id, state: plan.cleaned ? "arquivos já limpos" : plan.lifecycle.state, eligible: plan.eligible, expiresAt: plan.expiresAt, recoverableBytes: plan.recoverableBytes });
        }
        json(res, rows); return true;
      }
      const route = /^\/api\/cleanup\/projects\/([^/]+)\/(plan|confirm)$/.exec(url.pathname);
      if (!route) { json(res, { error: "não encontrado" }, 404); return true; }
      const dir = await project(decodeURIComponent(route[1]!));
      if (!dir) { json(res, { error: "Projeto não encontrado" }, 404); return true; }
      if (route[2] === "plan" && req.method === "GET") { json(res, await planProjectCleanup(dir, options)); return true; }
      if (route[2] === "confirm" && req.method === "POST") {
        let value: Record<string, unknown>;
        try { value = await body(req); } catch { json(res, { error: "pedido inválido" }, 400); return true; }
        if (typeof value.planId !== "string" || value.confirmed !== true) { json(res, { error: "confirmação explícita necessária" }, 400); return true; }
        const plan = await confirmProjectCleanup(dir, { planId: value.planId, confirmed: true, acknowledgeOffline: value.acknowledgeOffline === true }, options);
        json(res, { completed: true, recoverableBytes: plan.recoverableBytes }); return true;
      }
      json(res, { error: "método inválido" }, 405); return true;
    } catch (error) { const message = cleanupError(error); json(res, { error: message }, /incompleto|pendente|interrompida/.test(message) ? 503 : 409); return true; }
  }
  return {
    handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (url.pathname !== "/cleanup" && !url.pathname.startsWith("/hub/cleanup.") && !url.pathname.startsWith("/api/cleanup/")) return Promise.resolve(false);
      const pending = handle(req, res, url); active.add(pending);
      void pending.finally(() => active.delete(pending)).catch(() => {});
      return pending;
    },
    async close() { closed = true; await Promise.allSettled(active); },
  };
}
