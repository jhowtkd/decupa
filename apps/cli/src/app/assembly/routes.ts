import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAudio, hashFile, probe, readPcm } from "@decupa/media";
import { alignText } from "@decupa/transcript";
import { serveMedia } from "../../http/media.ts";
import { originAllowed } from "../../http/origin.ts";
import type { Executor } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import { analyzeSource } from "./analysis.ts";
import { runPreparation } from "./preparation.ts";
import { describeSource } from "./model.ts";
import { ensurePlayback, verifySourceIdentity } from "./media.ts";
import { visualCoverage } from "./visual.ts";
import { exportApproved } from "./export.ts";
import { renderAssembly } from "./render.ts";
import {
  applyEdit, applyHistorySnapshot, applyProposal, approveFinal, recordPreview,
} from "./revisions.ts";
import { proposeScenes, validateProposal } from "./scenes.ts";
import { selectLocalFiles, type SelectResult } from "./select.ts";
import { createProject, loadProject, mergeAnalyses, readHistorySnapshot, saveProject, writeHistorySnapshot } from "./store.ts";
import type { Project, Rate, Source } from "./types.ts";
import type { AlignmentOutcome } from "./words.ts";
import { parseEditAction, settleCorrection, snapWordCuts } from "./words.ts";

export const MAX_BODY_BYTES = 1024 * 1024;
export const PAID_BLOCKED = "análise paga exige lote e custo autorizados";

const HERE = dirname(fileURLToPath(import.meta.url));

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

/**
 * Barreira paga do percurso: modelo para propor, visual para fontes com
 * vídeo. Retorna o motivo do bloqueio ou null quando há autorização
 * (flag de lote, permissão persistida ou opt-in do clique). Pura para
 * teste sem HTTP; a rota converte em 402 antes de qualquer chamada.
 */
export function paidBlockedReason(
  project: Project,
  flags: {
    allowPaidModel?: boolean;
    allowPaidVisual?: boolean;
    proposeSend?: unknown;
    describeClient?: unknown;
  },
  opts: { modelOptIn: boolean; visualOptIn: boolean; needsModel: boolean },
): string | null {
  const modelOk = flags.allowPaidModel === true || project.permissions.model || opts.modelOptIn;
  const visualOk = flags.allowPaidVisual === true || project.permissions.visual || opts.visualOptIn;
  if (opts.needsModel && (!modelOk || !flags.proposeSend)) return PAID_BLOCKED;
  const needsVisual = project.assembly.sources.some((source) => source.included && source.hasVideo);
  if (needsVisual && (!visualOk || !flags.describeClient)) return PAID_BLOCKED;
  return null;
}

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
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

async function sourceFromFile(path: string, id: string, displayName?: string): Promise<Source> {
  if (!isAbsolute(path)) throw new HttpError(400, `fonte precisa de caminho absoluto: ${path}`);
  const resolved = await realpath(path);
  const info = await probe(resolved);
  const durationSeconds = Math.max(info.durationMs / 1000, 0.001);
  const { size, mtimeMs } = await stat(resolved);
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
    name: displayName ?? basename(resolved),
    size,
    mtimeMs,
  };
}

function nextSourceId(project: Project): string {
  return `src-${project.assembly.sources.length + 1}`;
}

function mediaError(err: unknown): HttpError {
  const message = err instanceof Error ? err.message : String(err);
  if (/ausente|não cadastrada/.test(message)) return new HttpError(404, message);
  return new HttpError(409, message);
}

const MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024;

function validImportName(raw: string | null): string {
  if (!raw || raw.length > 255 || /[/\\\0]/.test(raw)) {
    throw new HttpError(400, "nome de arquivo inválido para importação");
  }
  const name = raw.trim();
  if (name === "" || name === "." || name === "..") {
    throw new HttpError(400, "nome de arquivo inválido para importação");
  }
  return raw;
}

/**
 * Publica o resultado do alinhamento sem criar revisão nova: é a conclusão
 * da edição que registrou o pending. CAS pelo expectedRevision descarta o
 * resultado quando outra edição ou undo passou na frente (obsoleto).
 */
async function publishCorrection(
  dir: string,
  expectedRevision: number,
  correctionId: string,
  outcome: AlignmentOutcome,
): Promise<void> {
  try {
    await saveProject(dir, expectedRevision, (current) => {
      const correction = current.corrections.find((item) => item.id === correctionId);
      if (!correction || correction.status !== "pending") {
        throw new Error(`correção ${correctionId} obsoleta`);
      }
      try {
        return settleCorrection(current, correctionId, outcome);
      } catch (err) {
        return settleCorrection(current, correctionId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } catch {
    // Revisão andou: resultado obsoleto, descarta sem tocar no projeto.
  }
}

/**
 * Alinha uma correção pendente em background: recorta o áudio, roda o
 * sidecar com --text-file (sem ASR), refina os cortes com snapCut e publica
 * via CAS. Nunca derruba o servidor; o pending permite retomada.
 */
async function alignCorrectionJob(
  dir: string,
  correctionId: string,
  expectedRevision: number,
): Promise<void> {
  try {
    const current = await loadProject(dir);
    if (current.revision !== expectedRevision) return;
    const correction = current.corrections.find((item) => item.id === correctionId);
    if (!correction || correction.status !== "pending") return;
    const source = current.assembly.sources.find((item) => item.id === correction.sourceId);
    if (!source) {
      await publishCorrection(dir, expectedRevision, correctionId, {
        error: `fonte ausente: ${correction.sourceId}`,
      });
      return;
    }
    let transcript;
    try {
      transcript = await alignText({
        input: source.path,
        text: correction.text,
        startSeconds: correction.start,
        endSeconds: correction.end,
      });
    } catch (err) {
      await publishCorrection(dir, expectedRevision, correctionId, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const words: {
      text: string; start: number; end: number;
      confidence: number | null; cutStart?: number; cutEnd?: number;
    }[] = transcript.tokens.map((token) => ({
      text: token.text,
      start: token.startMs / 1000,
      end: token.endMs / 1000,
      confidence: token.confidence,
    }));
    try {
      const clipDir = await mkdtemp(join(tmpdir(), "decupa-snap-"));
      try {
        const wav = join(clipDir, "clip.wav");
        await extractAudio({
          input: source.path,
          output: wav,
          startSeconds: correction.start,
          durationSeconds: correction.end - correction.start,
        });
        const pcm = await readPcm({ input: wav });
        const cuts = snapWordCuts(
          pcm,
          words.map((word) => ({ start: word.start - correction.start, end: word.end - correction.start })),
        );
        for (const [i, word] of words.entries()) {
          word.cutStart = cuts[i]!.start + correction.start;
          word.cutEnd = cuts[i]!.end + correction.start;
        }
      } finally {
        await rm(clipDir, { recursive: true, force: true });
      }
    } catch {
      // Sem refino acústico, valem as fronteiras do alinhamento.
    }
    await publishCorrection(dir, expectedRevision, correctionId, { words });
  } catch {
    // O pending segue retomável; o erro será registrado na próxima tentativa.
  }
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

  // Módulos ES do editor texto-centrado, servidos sem build: leitura única
  // por arquivo com cache em memória, como page.js no startup do servidor.
  // O nome restrito a kebab-case impede escape do diretório editor/.
  const editorFiles = new Map<string, string>();
  async function serveEditor(res: ServerResponse, name: string): Promise<boolean> {
    if (!/^[a-z0-9-]+\.js$/.test(name)) return false;
    let body = editorFiles.get(name);
    if (body === undefined) {
      try {
        body = await readFile(join(HERE, "editor", name), "utf8");
      } catch {
        return false;
      }
      editorFiles.set(name, body);
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }

  async function handleAssembly(
    req: IncomingMessage,
    res: ServerResponse,
    projectDir: string,
  ): Promise<boolean> {
    if (projectDir !== dir) return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/project") && !url.pathname.startsWith("/editor/")) return false;
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method !== "GET" && !originAllowed(req.headers.origin, deps.port())) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return true;
      }

      if (parts[0] === "editor" && req.method === "GET" && (await serveEditor(res, parts[1] ?? ""))) return true;

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
        if (url.searchParams.get("view") === "playback") {
          try {
            const { videoPath } = await ensurePlayback(source, dir, deps.exec);
            await serveMedia(req, res, videoPath);
          } catch (err) {
            throw mediaError(err);
          }
          return true;
        }
        try {
          await verifySourceIdentity(source);
        } catch (err) {
          throw mediaError(err);
        }
        await serveMedia(req, res, source.path);
        return true;
      }

      if (parts[1] === "thumbnail" && req.method === "GET") {
        const sourceId = decodeURIComponent(parts[2] ?? "");
        const project = await loadProject(dir);
        const source = project.assembly.sources.find((item) => item.id === sourceId);
        if (!source) throw new HttpError(404, "fonte não cadastrada");
        try {
          const { thumbnailPath } = await ensurePlayback(source, dir, deps.exec);
          if (!thumbnailPath) throw new HttpError(404, "fonte sem miniatura (somente áudio)");
          await serveMedia(req, res, thumbnailPath, "image/jpeg");
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw mediaError(err);
        }
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

      if (parts[1] === "import" && req.method === "POST") {
        const baseRevision = Number(url.searchParams.get("baseRevision"));
        if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
          throw new HttpError(400, "baseRevision inválido");
        }
        const name = validImportName(url.searchParams.get("name"));
        const declared = Number(req.headers["x-file-size"]);
        if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_IMPORT_BYTES) {
          throw new HttpError(400, "x-file-size ausente ou inválido");
        }
        const before = await loadProject(dir);
        if (before.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${before.revision}`);
        }
        // Arquivos arrastados são copiados para o projeto local por stream;
        // o seletor nativo continua referenciando o original sem cópia.
        const importsDir = join(dir, "imports");
        await mkdir(importsDir, { recursive: true });
        const part = join(importsDir, `${randomUUID()}.part`);
        const cleanup = () => unlink(part).catch(() => {});
        let received = 0;
        try {
          const handle = await open(part, "wx");
          try {
            for await (const chunk of req) {
              const buf = chunk as Buffer;
              received += buf.length;
              if (received > declared) throw new HttpError(400, "tamanho além do declarado");
              await handle.write(buf);
            }
          } finally {
            await handle.close();
          }
        } catch (err) {
          await cleanup();
          if (err instanceof HttpError) throw err;
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOSPC") throw new HttpError(507, "sem espaço local para importar");
          throw err;
        }
        if (received !== declared) {
          await cleanup();
          throw new HttpError(400, "tamanho recebido diverge do declarado");
        }
        let info;
        try {
          info = await probe(part);
        } catch {
          await cleanup();
          throw new HttpError(400, "arquivo não decodificável como mídia");
        }
        if (!info.hasVideo && !info.hasAudio) {
          await cleanup();
          throw new HttpError(400, "arquivo sem áudio nem vídeo");
        }
        const sha256 = await hashFile(part);
        const known = before.assembly.sources.find((item) => item.sha256 === sha256);
        if (known) {
          await cleanup();
          sendJson(res, { project: await loadProject(dir), source: known, reused: true });
          return true;
        }
        const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1] ?? "bin";
        const stored = join(importsDir, `${randomUUID()}.${ext}`);
        try {
          await rename(part, stored);
        } catch (err) {
          await cleanup();
          throw err;
        }
        let project: Project;
        try {
          project = await mutate(baseRevision, async (loaded) => {
            const source = await sourceFromFile(stored, nextSourceId(loaded), name);
            return bump(addSource(loaded, source));
          });
        } catch (err) {
          await unlink(stored).catch(() => {});
          throw err;
        }
        // sourceFromFile canonicaliza com realpath; a grafia de `stored`
        // pode divergir (ex.: /var vs /private/var no macOS). Compara pelo
        // caminho canônico para nunca devolver 200 sem source (V8).
        const canonical = await realpath(stored).catch(() => stored);
        const source = project.assembly.sources.find((item) => item.path === canonical);
        sendJson(res, { project, source });
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
        const rawIds = Array.isArray(body.sourceIds)
          ? body.sourceIds
          : body.sourceId !== undefined ? [body.sourceId] : [];
        const sourceIds = rawIds.map(String);
        if (sourceIds.length === 0) throw new HttpError(400, "sourceIds ausente");
        const role = body.role;
        if (role !== "speech" && role !== "support" && role !== "both") {
          throw new HttpError(400, "role inválido");
        }
        const project = await mutate(baseRevision, (project) => {
          const nextRole = role as Source["role"];
          const known = new Set(project.assembly.sources.map((source) => source.id));
          for (const id of sourceIds) {
            if (!known.has(id)) throw new HttpError(404, `fonte não cadastrada: ${id}`);
          }
          const wanted = new Set(sourceIds);
          const sources = project.assembly.sources.map((source) =>
            wanted.has(source.id) ? { ...source, role: nextRole } : source,
          );
          return bump({ ...project, assembly: { ...project.assembly, sources } });
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "source-selection" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : [];
        if (sourceIds.length === 0) throw new HttpError(400, "sourceIds ausente");
        if (typeof body.included !== "boolean") throw new HttpError(400, "included inválido");
        const included = body.included;
        const project = await mutate(baseRevision, (project) => {
          const known = new Set(project.assembly.sources.map((source) => source.id));
          for (const id of sourceIds) {
            if (!known.has(id)) throw new HttpError(404, `fonte não cadastrada: ${id}`);
          }
          const wanted = new Set(sourceIds);
          const sources = project.assembly.sources.map((source) =>
            wanted.has(source.id) ? { ...source, included } : source,
          );
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
              analysis.visualCoverage = visualCoverage(analysis.visual, source.durationSeconds);
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

      if ((parts[1] === "prepare" || parts[1] === "adjust") && req.method === "POST") {
        const mode = parts[1] as "prepare" | "adjust";
        const baseRevision = requireRevision(body);
        const request = String(body.request ?? "");
        const modelOptIn = body.modelOptIn === true;
        const visualOptIn = body.visualOptIn === true;
        const current = await loadProject(dir);
        if (current.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${current.revision}`);
        }
        if (mode === "adjust" && current.scenes.length === 0) {
          throw new HttpError(409, "nada a ajustar: ainda não há cenas; use prepare");
        }
        const blocked = paidBlockedReason(
          current,
          { allowPaidModel: deps.allowPaidModel, allowPaidVisual: deps.allowPaidVisual, proposeSend: deps.proposeSend, describeClient: deps.describeClient },
          { modelOptIn, visualOptIn, needsModel: true },
        );
        if (blocked) throw new HttpError(402, blocked);
        // Um novo início cancela o anterior (mesma semântica de analyze e
        // propose): o percurso abortado registra cancelled sem escrever mais.
        const { gen, signal } = begin("preparing");
        void runPreparation(
          dir,
          baseRevision,
          { mode, request, modelOptIn, visualOptIn },
          { exec: deps.exec, proposeSend: deps.proposeSend, describeClient: deps.describeClient },
          { signal, isCurrent: () => stillCurrent(gen) },
        ).then(
          () => {
            if (stillCurrent(gen)) operation = { stage: "ready" };
          },
          (err: unknown) => {
            if (stillCurrent(gen)) {
              operation = { stage: "error", error: err instanceof Error ? err.message : String(err) };
            }
          },
        );
        sendJson(res, { project: await loadProject(dir), ...snapshot() }, 202);
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

      if (parts[1] === "edit" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        let action;
        try {
          action = parseEditAction(body.action);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        // Descobre o id da correção de forma pura antes de salvar
        // (mint determinístico: o save reaplica o mesmo id).
        let correctionId: string | null = null;
        if (action.type === "correct") {
          const current = await loadProject(dir);
          if (current.revision !== baseRevision) {
            throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${current.revision}`);
          }
          try {
            const preview = applyEdit(current, action);
            const oldIds = new Set(current.corrections.map((item) => item.id));
            const created = preview.corrections.map((item) => item.id).filter((id) => !oldIds.has(id));
            if (created.length !== 1 || !created[0]) throw new Error("correção não criada");
            correctionId = created[0];
          } catch (err) {
            throw new HttpError(400, err instanceof Error ? err.message : String(err));
          }
        }
        let project: Project;
        try {
          project = await mutate(baseRevision, async (loaded) => {
            await writeHistorySnapshot(dir, loaded);
            return applyEdit(loaded, action);
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        if (correctionId) {
          // Alinhamento continua em background; o pending permite retomada.
          void alignCorrectionJob(dir, correctionId, project.revision);
          sendJson(res, { project, ...snapshot() }, 202);
          return true;
        }
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "undo" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const target = Number(body.revision);
        if (!Number.isSafeInteger(target) || target < 0) {
          throw new HttpError(400, "revision inválida para desfazer");
        }
        const loaded = await loadProject(dir);
        if (loaded.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${loaded.revision}`);
        }
        if (target >= loaded.revision) {
          throw new HttpError(409, "nada a desfazer nessa revisão");
        }
        let snap;
        try {
          snap = await readHistorySnapshot(dir, target);
        } catch (err) {
          throw new HttpError(404, err instanceof Error ? err.message : String(err));
        }
        await writeHistorySnapshot(dir, loaded);
        try {
          // Forma funcional: substitui o conteúdo editorial (sem unir correções
          // antigas de volta) e valida antes de gravar.
          await saveProject(dir, baseRevision, (current) => applyHistorySnapshot(current, snap));
        } catch (err) {
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        }
        sendJson(res, { project: await loadProject(dir), ...snapshot() });
        return true;
      }

      if (parts[1] === "preview" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const { gen } = begin("rendering");
        const project = await mutate(baseRevision, async (project) => {
          let reference: string;
          try {
            reference = await renderAssembly(project.assembly, dir, deps.exec);
          } catch (err) {
            // Sem isso a operação ficava presa em "rendering" e travava
            // a atualização automática mesmo após o erro (R2).
            if (stillCurrent(gen)) {
              operation = { stage: "error", error: err instanceof Error ? err.message : String(err) };
            }
            throw err;
          }
          if (!stillCurrent(gen)) return project;
          operation = { stage: "ready" };
          const assemblySha256 = createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex");
          return recordPreview(project, {
            revision: project.revision,
            assemblySha256,
            relativePath: relative(dir, reference),
            sha256: await hashFile(reference),
          });
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      if (parts[1] === "approve-final" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const watchedRevision = Number(body.watchedRevision);
        if (!Number.isSafeInteger(watchedRevision) || watchedRevision < 0) {
          throw new HttpError(400, "watchedRevision inválido: confirme a revisão assistida");
        }
        const project = await mutate(baseRevision, (project) => {
          try {
            return approveFinal(project, watchedRevision);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new HttpError(/assistida/.test(message) ? 400 : 409, message);
          }
        });
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
          const dest = await exportApproved(loaded, dir);
          sendJson(res, { project: loaded, path: dest, ...snapshot() });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/aprovação final|mídia ausente|substitu|absoluto|andamento|prévia|mudou durante/.test(message)) {
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
