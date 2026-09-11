import { randomUUID } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { hashFile, probe } from "@decupa/media";
import { serveMedia } from "../../http/media.ts";
import { originAllowed } from "../../http/origin.ts";
import type { Executor } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import { analyzeSource } from "./analysis.ts";
import { describeSource } from "./model.ts";
import { exportApproved } from "./export.ts";
import { renderAssembly } from "./render.ts";
import {
  applyProposal, approveFinal, approveStructure, recordPreview,
} from "./revisions.ts";
import { proposeScenes, validateProposal } from "./scenes.ts";
import { selectLocalFiles, type SelectResult } from "./select.ts";
import { createProject, loadProject, mergeAnalyses, saveProject } from "./store.ts";
import type { Project, Rate, Source } from "./types.ts";

export const MAX_BODY_BYTES = 1024 * 1024;
export const PAID_BLOCKED = "análise paga exige lote e custo autorizados";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type AssemblyOperation = {
  stage: string;
  sourceId?: string;
  progress?: string;
  error?: string;
} | null;

export type AssemblyDeps = {
  exec: Executor;
  port: () => number;
  selectFn?: () => Promise<SelectResult>;
  proposeSend?: (content: unknown[], signal?: AbortSignal) => Promise<string>;
  describeClient?: { send(content: unknown[], signal?: AbortSignal): Promise<string> };
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
};

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readLimitedBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body grande demais");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "body inválido");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "body inválido");
  }
}

function emptyTracks(): Project["assembly"]["tracks"] {
  return [
    { kind: "Video", name: "V1", clips: [] },
    { kind: "Video", name: "V2", clips: [] },
    { kind: "Audio", name: "A1", clips: [] },
  ];
}

export function blankProject(id: string): Project {
  return {
    version: 2,
    id,
    revision: 0,
    input: { kind: "brief", text: "", targetSeconds: 60 },
    assembly: {
      version: 1,
      revision: 0,
      name: id,
      fps: { num: 25, den: 1 },
      width: 320,
      height: 240,
      sources: [],
      tracks: emptyTracks(),
    },
    scenes: [],
    analyses: [],
    proposal: null,
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
    corrections: [],
    preparation: null,
    permissions: { model: false, visual: false },
    previewArtifact: null,
  };
}

function bump(project: Project): Project {
  const revision = project.revision + 1;
  return {
    ...project,
    revision,
    assembly: { ...project.assembly, revision },
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

async function sourceFromFile(path: string, id: string): Promise<Source> {
  if (!isAbsolute(path)) throw new HttpError(400, `fonte precisa de caminho absoluto: ${path}`);
  const resolved = await realpath(path);
  const info = await probe(resolved);
  const durationSeconds = Math.max(info.durationMs / 1000, 0.001);
  return {
    id,
    path: resolved,
    sha256: await hashFile(resolved),
    durationSeconds,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    fps: info.frameRate,
    width: info.width,
    height: info.height,
    role: info.hasAudio ? "speech" : "support",
    included: true,
  };
}

function nextSourceId(project: Project): string {
  return `src-${project.assembly.sources.length + 1}`;
}

function requireRevision(body: Record<string, unknown>): number {
  const n = Number(body.baseRevision);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, "baseRevision inválido");
  return n;
}

function applyCanvasFrom(project: Project, source: Source): Project {
  if (project.assembly.sources.length > 0 || !source.hasVideo) return project;
  const fps: Rate = source.fps ?? project.assembly.fps;
  const width = source.width && source.width % 2 === 0 ? source.width : project.assembly.width;
  const height = source.height && source.height % 2 === 0 ? source.height : project.assembly.height;
  return {
    ...project,
    assembly: { ...project.assembly, fps, width, height },
  };
}

function addSource(project: Project, source: Source): Project {
  if (project.assembly.sources.some((item) => item.path === source.path)) return project;
  const withCanvas = applyCanvasFrom(project, source);
  return {
    ...withCanvas,
    assembly: {
      ...withCanvas.assembly,
      sources: [...withCanvas.assembly.sources, source],
    },
  };
}

export function createAssemblyRuntime(dir: string, deps: AssemblyDeps) {
  let operation: AssemblyOperation = null;
  let opGen = 0;
  let cancelled = false;
  let controller: AbortController | null = null;
  const select = deps.selectFn ?? selectLocalFiles;

  function snapshot() {
    return { operation };
  }

  function begin(stage: string, sourceId?: string): { gen: number; signal: AbortSignal } {
    cancelled = false;
    controller?.abort();
    if (deps.exec instanceof SpawnExecutor) deps.exec.killAll();
    controller = new AbortController();
    const gen = ++opGen;
    operation = { stage, sourceId };
    return { gen, signal: controller.signal };
  }

  function stillCurrent(gen: number): boolean {
    return !cancelled && gen === opGen;
  }

  async function ensureProject(inputs?: string[]): Promise<Project> {
    await mkdir(dir, { recursive: true });
    try {
      await access(join(dir, "project.json"));
    } catch {
      await createProject(dir, blankProject(randomUUID()));
    }
    let project = await loadProject(dir);
    if (!inputs?.length) return project;
    const expected = project.revision;
    let changed = false;
    for (const input of inputs) {
      const before = project.assembly.sources.length;
      project = addSource(project, await sourceFromFile(input, nextSourceId(project)));
      if (project.assembly.sources.length > before) changed = true;
    }
    if (changed) {
      project = bump(project);
      await saveProject(dir, expected, project);
    }
    return loadProject(dir);
  }

  async function mutate(
    expected: number,
    fn: (project: Project) => Project | Promise<Project>,
  ): Promise<Project> {
    const loaded = await loadProject(dir);
    if (loaded.revision !== expected) {
      throw new HttpError(409, `revisão desatualizada: base ${expected}, atual ${loaded.revision}`);
    }
    const next = await fn(loaded);
    try {
      await saveProject(dir, expected, next, loaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/revisão desatualizada/.test(message)) throw new HttpError(409, message);
      throw err;
    }
    return loadProject(dir);
  }

  async function pickFiles(): Promise<SelectResult> {
    return select();
  }

  async function handleAssembly(
    req: IncomingMessage,
    res: ServerResponse,
    projectDir: string,
  ): Promise<boolean> {
    if (projectDir !== dir) return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/project")) return false;
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method !== "GET" && !originAllowed(req.headers.origin, deps.port())) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return true;
      }

      if (parts.length === 1 && req.method === "GET") {
        const project = await loadProject(dir);
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "media" && req.method === "GET") {
        const sourceId = decodeURIComponent(parts[2] ?? "");
        const project = await loadProject(dir);
        const source = project.assembly.sources.find((item) => item.id === sourceId);
        if (!source) throw new HttpError(404, "fonte não cadastrada");
        await serveMedia(req, res, source.path);
        return true;
      }

      if (parts[1] === "output" && req.method === "GET") {
        const revision = parts[2] ?? "";
        const kind = parts[3] ?? "";
        const file = kind === "otio" ? "timeline.otio" : kind === "mp4" ? "reference.mp4" : "";
        if (!file) throw new HttpError(404, "saída desconhecida");
        const type = kind === "otio" ? "application/json" : "video/mp4";
        const candidates = [join(dir, "exports", revision, file)];
        if (kind === "mp4") candidates.push(join(dir, `rev-${revision}`, "reference.mp4"));
        let served = false;
        for (const path of candidates) {
          try {
            await serveMedia(req, res, path, type);
            served = true;
            break;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw err;
          }
        }
        if (!served) throw new HttpError(404, "saída não registrada");
        return true;
      }

      if (parts[1] === "cancel" && req.method === "POST") {
        cancelled = true;
        controller?.abort();
        if (deps.exec instanceof SpawnExecutor) deps.exec.killAll();
        operation = { stage: "cancelled" };
        sendJson(res, { ok: true, ...snapshot() });
        return true;
      }

      const body = await readLimitedBody(req);

      if (parts[1] === "select" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const picked = await pickFiles();
        if ("cancelled" in picked) {
          sendJson(res, { cancelled: true, project: await loadProject(dir), ...snapshot() });
          return true;
        }
        const project = await mutate(baseRevision, async (project) => {
          let next = project;
          for (const path of picked.paths) {
            next = addSource(next, await sourceFromFile(path, nextSourceId(next)));
          }
          return bump(next);
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "input" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const kind = body.kind === "script" ? "script" : body.kind === "brief" ? "brief" : null;
        if (!kind) throw new HttpError(400, "kind inválido");
        if (typeof body.text !== "string") throw new HttpError(400, "text inválido");
        const targetSeconds = Number(body.targetSeconds);
        if (!Number.isFinite(targetSeconds)) throw new HttpError(400, "targetSeconds inválido");
        const project = await mutate(baseRevision, (project) => bump({
          ...project,
          input: { kind, text: body.text as string, targetSeconds },
        }));
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "settings" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const fpsRaw = body.fps as { num?: unknown; den?: unknown } | undefined;
        const width = Number(body.width);
        const height = Number(body.height);
        if (!fpsRaw || !Number.isSafeInteger(fpsRaw.num) || !Number.isSafeInteger(fpsRaw.den)) {
          throw new HttpError(400, "fps inválido");
        }
        const project = await mutate(baseRevision, (project) => bump({
          ...project,
          assembly: {
            ...project.assembly,
            fps: { num: Number(fpsRaw.num), den: Number(fpsRaw.den) },
            width,
            height,
          },
        }));
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "source-role" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const sourceId = String(body.sourceId ?? "");
        const role = body.role;
        if (role !== "speech" && role !== "support" && role !== "both") {
          throw new HttpError(400, "role inválido");
        }
        const project = await mutate(baseRevision, (project) => {
          const nextRole = role as Source["role"];
          const sources = project.assembly.sources.map((source) =>
            source.id === sourceId ? { ...source, role: nextRole } : source,
          );
          if (!sources.some((source) => source.id === sourceId)) {
            throw new HttpError(404, "fonte não cadastrada");
          }
          return bump({ ...project, assembly: { ...project.assembly, sources } });
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "relink" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const sourceId = String(body.sourceId ?? "");
        const picked = await pickFiles();
        if ("cancelled" in picked) {
          sendJson(res, { cancelled: true, project: await loadProject(dir), ...snapshot() });
          return true;
        }
        const chosen = picked.paths[0];
        if (!chosen) throw new HttpError(400, "nenhum arquivo selecionado");
        const project = await mutate(baseRevision, async (project) => {
          const source = project.assembly.sources.find((item) => item.id === sourceId);
          if (!source) throw new HttpError(404, "fonte não cadastrada");
          const next = await sourceFromFile(chosen, sourceId);
          if (next.sha256 !== source.sha256) {
            throw new HttpError(409, "hash diferente do original");
          }
          return {
            ...project,
            assembly: {
              ...project.assembly,
              sources: project.assembly.sources.map((item) =>
                item.id === sourceId ? { ...item, path: next.path } : item,
              ),
            },
          };
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "analyze" && req.method === "POST") {
        const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : [];
        if (sourceIds.length === 0) throw new HttpError(400, "sourceIds ausente");
        const wantVisual = body.visual === true;
        if (wantVisual && (!deps.allowPaidVisual || !deps.describeClient)) {
          throw new HttpError(402, PAID_BLOCKED);
        }
        const { gen, signal } = begin("analyzing");
        const project = await loadProject(dir);
        let done = 0;
        for (const sourceId of sourceIds) {
          if (!stillCurrent(gen)) break;
          const source = project.assembly.sources.find((item) => item.id === sourceId);
          if (!source) throw new HttpError(404, `fonte não cadastrada: ${sourceId}`);
          operation = {
            stage: "analyzing",
            sourceId,
            progress: `${done + 1}/${sourceIds.length}`,
          };
          const analysis = await analyzeSource(source, dir, deps.exec);
          if (wantVisual && deps.describeClient && source.hasVideo && !signal.aborted) {
            try {
              analysis.visual = await describeSource(source, dir, signal, {
                client: deps.describeClient,
                exec: deps.exec,
              });
            } catch (err) {
              analysis.status = "partial";
              analysis.error = err instanceof Error ? err.message : String(err);
            }
          }
          try {
            await saveProject(dir, project.revision, (current) => {
              if (current.revision !== project.revision) {
                throw new HttpError(
                  409,
                  `revisão desatualizada: base ${project.revision}, atual ${current.revision}`,
                );
              }
              return { ...current, analyses: mergeAnalyses(current.analyses, [analysis]) };
            });
          } catch (err) {
            if (err instanceof HttpError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            if (/revisão desatualizada/.test(message)) throw new HttpError(409, message);
            throw err;
          }
          done += 1;
          if (!stillCurrent(gen)) break;
        }
        if (stillCurrent(gen)) operation = { stage: "ready", progress: `${done}/${sourceIds.length}` };
        sendJson(res, { project: await loadProject(dir), ...snapshot() });
        return true;
      }

      if (parts[1] === "propose" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const project = await mutate(baseRevision, async (project) => {
          if (body.proposal && typeof body.proposal === "object") {
            const proposal = validateProposal(body.proposal, project);
            return { ...project, proposal };
          }
          const request = String(body.request ?? "");
          if (!deps.allowPaidModel || !deps.proposeSend) {
            throw new HttpError(402, PAID_BLOCKED);
          }
          const { gen, signal } = begin("proposing");
          const proposal = await proposeScenes(project, request, signal, {
            send: deps.proposeSend,
          });
          if (!stillCurrent(gen)) return project;
          operation = { stage: "ready" };
          return { ...project, proposal };
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "apply" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const proposalId = String(body.proposalId ?? "");
        const project = await mutate(baseRevision, (project) => {
          if (!project.proposal || project.proposal.id !== proposalId) {
            throw new HttpError(409, "proposta ausente ou desatualizada");
          }
          return applyProposal(project, project.proposal);
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "approve-structure" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const project = await mutate(baseRevision, (project) => approveStructure(project));
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "preview" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const { gen } = begin("rendering");
        const project = await mutate(baseRevision, async (project) => {
          if (project.structureApprovedRevision !== project.revision) {
            throw new HttpError(409, "prévia exige estrutura aprovada na revisão atual");
          }
          await renderAssembly(project.assembly, dir, deps.exec);
          if (!stillCurrent(gen)) return project;
          operation = { stage: "ready" };
          return recordPreview(project, project.revision);
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "approve-final" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const project = await mutate(baseRevision, (project) => approveFinal(project));
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "export" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const loaded = await loadProject(dir);
        if (loaded.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${loaded.revision}`);
        }
        try {
          const dest = await exportApproved(loaded, dir, deps.exec);
          sendJson(res, { project: loaded, path: dest, ...snapshot() });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/aprovação final|mídia ausente|substitu|absoluto|andamento/.test(message)) {
            throw new HttpError(409, message);
          }
          throw err;
        }
        return true;
      }

      return false;
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, { error: err.message }, err.status);
        return true;
      }
      throw err;
    }
  }

  return { ensureProject, handleAssembly, snapshot };
}
