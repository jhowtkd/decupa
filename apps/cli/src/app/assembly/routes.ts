import { publishAtomic } from "@decupa/cache";
import { loadRecipe } from "../templates/store.ts";
import { deliverApproved, readDelivery } from "./delivery.ts";
import { brollCandidates, candidateSupport } from "./broll.ts";
import type { AssemblyDecisionContext } from "./assembly-decisions.ts";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAudio, hashFile, probe, readPcm } from "@decupa/media";
import { isCancelledError } from "@decupa/queue";
import { alignText } from "@decupa/transcript";
import { serveMedia } from "../../http/media.ts";
import { originAllowed } from "../../http/origin.ts";
import { applyCanvasPolicy, canvasForSource } from "./canvas.ts";
import { parseSourceTimecode } from "./timecode.ts";
import type { Executor, IngestSpeech } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import { analyzeSource } from "./analysis.ts";
import { holdPreparation, isPreparationActive, runPreparation } from "./preparation.ts";
import { describeSource, type VisualClient } from "./model.ts";
import { ensurePlayback, ensureThumbnail, verifySourceIdentity } from "./media.ts";
import { visualCoverage } from "./visual.ts";
import { confirmImportVerification, exportApproved, readVerification } from "./export.ts";
import { applySpeechProposal, proposeSpeechAdjustment, type SpeechProposal } from "./speech-proposal.ts";
import { applySupportSwap, buildSupportSwapProposal, type SupportSwapProposal } from "./support-swap.ts";
import {
  applyRhythmProposal, buildRhythmProposal, rhythmProfile, rhythmSampleAssembly,
  RHYTHM_PROFILES, type RhythmProposal,
} from "./rhythm.ts";
import { renderAssembly } from "./render.ts";
import { buildTemplateReport } from "./template-report.ts";
import { peaksPath } from "./waveform.ts";
import {
  applyEdit, applyHistorySnapshot, applyProposal, approveFinal, recordPreview,
} from "./revisions.ts";
import { proposeScenes, validateProposal } from "./scenes.ts";
import { selectLocalFiles, type SelectResult } from "./select.ts";
import { createProject, loadProject, mergeAnalyses, readHistorySnapshot, saveProject, writeHistorySnapshot } from "./store.ts";
import type { Project, Source } from "./types.ts";
import type { AlignmentOutcome } from "./words.ts";
import { parseEditAction, settleCorrection, snapWordCuts } from "./words.ts";

const alignActive = new Set<string>();
function alignKey(dir: string, correctionId: string): string {
  return `${dir}\0${correctionId}`;
}

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
  templatesRoot?: string;
  decision?: AssemblyDecisionContext;
  exec: Executor;
  port: () => number;
  selectFn?: () => Promise<SelectResult>;
  proposeSend?: (content: unknown[], signal?: AbortSignal) => Promise<string>;
  describeClient?: VisualClient;
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  speech?: IngestSpeech;
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
    timecode: info.timecode ? parseSourceTimecode(info.timecode, info.frameRate) : null,
    rotation: info.rotation,
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
 * da edição que registrou o pending. Faz rebase com até 3 tentativas caso a
 * revisão tenha avançado por edições concorrentes de texto/corte.
 */
export async function publishCorrection(
  dir: string,
  _expectedRevision: number,
  correctionId: string,
  outcome: AlignmentOutcome,
): Promise<void> {
  const settleError = async (message: string) => {
    const fresh = await loadProject(dir);
    const pending = fresh.corrections.find((item) => item.id === correctionId);
    if (!pending || pending.status !== "pending") return;
    await saveProject(dir, fresh.revision, (current) => {
      const correction = current.corrections.find((item) => item.id === correctionId);
      if (!correction || correction.status !== "pending") return current;
      return settleCorrection(current, correctionId, { error: message });
    });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fresh = await loadProject(dir);
      const correction = fresh.corrections.find((item) => item.id === correctionId);
      if (!correction || correction.status !== "pending") return;
      await saveProject(dir, fresh.revision, (current) => {
        try {
          return settleCorrection(current, correctionId, outcome);
        } catch (err) {
          return settleCorrection(current, correctionId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      return;
    } catch (err) {
      if (err instanceof Error && /revisão desatualizada/.test(err.message)) continue;
      await settleError(err instanceof Error ? err.message : String(err)).catch(() => undefined);
      return;
    }
  }
  await settleError("correção não aplicada após 3 tentativas de rebase concorrente").catch(() => undefined);
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
  const key = alignKey(dir, correctionId);
  if (alignActive.has(key)) return;
  alignActive.add(key);
  try {
    const current = await loadProject(dir);
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
  } catch (err) {
    await publishCorrection(dir, expectedRevision, correctionId, {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
  } finally {
    alignActive.delete(key);
  }
}

function requireRevision(body: Record<string, unknown>): number {
  const n = Number(body.baseRevision);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, "baseRevision inválido");
  return n;
}

function addSource(project: Project, source: Source): Project {
  if (project.assembly.sources.some((item) => item.path === source.path)) return project;
  return {
    ...project,
    assembly: {
      ...project.assembly,
      sources: [...project.assembly.sources, source],
    },
  };
}

export function createAssemblyRuntime(dir: string, deps: AssemblyDeps) {
  let operation: AssemblyOperation = null;
  let opGen = 0;
  let cancelled = false;
  let controller: AbortController | null = null;
  const livePreviews = new Set<AbortController>();
  const templateProposalPath=join(dir,"template-proposal.json");
  const speechProposalPath=join(dir,"speech-proposal.json");
  const supportSwapPath=join(dir,"support-swap.json");
  const rhythmProposalPath=join(dir,"rhythm-proposal.json");
  async function readTemplateProposal(){
    try{return JSON.parse(await readFile(templateProposalPath,"utf8")) as import("./types.ts").Proposal;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  }
  const select = deps.selectFn ?? selectLocalFiles;

  function snapshot() {
    return { operation };
  }

  function abortOperations(): void {
    controller?.abort();
    for (const preview of livePreviews) preview.abort();
  }

  function begin(stage: string, sourceId?: string): { gen: number; signal: AbortSignal } {
    cancelled = false;
    abortOperations();
    livePreviews.clear();
    if (deps.exec instanceof SpawnExecutor) deps.exec.killAll();
    controller = new AbortController();
    const gen = ++opGen;
    operation = { stage, sourceId };
    return { gen, signal: controller.signal };
  }

  // Prévia manual aguardada: controller próprio, sem derrubar a anterior —
  // cada pedido completa (a fila de mídia serializa). /cancel aborta todas.
  function beginPreview(): { gen: number; signal: AbortSignal; settle: () => void } {
    cancelled = false;
    const own = new AbortController();
    livePreviews.add(own);
    const gen = ++opGen;
    operation = { stage: "rendering" };
    return { gen, signal: own.signal, settle: () => { livePreviews.delete(own); } };
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
      project = bump(applyCanvasPolicy(project));
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

      const readSpeechProposal = async (): Promise<SpeechProposal | null> => {
        try {
          const parsed = JSON.parse(await readFile(speechProposalPath, "utf8")) as SpeechProposal;
          if (!parsed || typeof parsed.id !== "string" || typeof parsed.baseRevision !== "number"
            || !parsed.scope) return null;
          return parsed;
        } catch {
          return null;
        }
      };
      const readSupportSwap = async (): Promise<SupportSwapProposal | null> => {
        try {
          const parsed = JSON.parse(await readFile(supportSwapPath, "utf8")) as SupportSwapProposal;
          if (!parsed || typeof parsed.id !== "string" || typeof parsed.baseRevision !== "number"
            || !parsed.scope) return null;
          return parsed;
        } catch {
          return null;
        }
      };
      const readRhythmProposal = async (): Promise<RhythmProposal | null> => {
        try {
          const parsed = JSON.parse(await readFile(rhythmProposalPath, "utf8")) as RhythmProposal;
          if (!parsed || typeof parsed.id !== "string" || typeof parsed.baseRevision !== "number"
            || !parsed.profileId) return null;
          return parsed;
        } catch {
          return null;
        }
      };

      if (parts.length === 1 && req.method === "GET") {
        let project = await loadProject(dir);
        if (project.preparation?.status === "running" && !isPreparationActive(dir)) {
          try {
            await saveProject(dir, project.revision, (current) => {
              if (current.preparation?.status === "running") {
                return {
                  ...current,
                  preparation: {
                    ...current.preparation,
                    status: "interrupted",
                    error: "preparação interrompida: servidor reiniciado; clique em Retomar",
                  },
                };
              }
              return current;
            });
            project = await loadProject(dir);
          } catch {
            // Se falhou o salvamento atômico, devolve o que tem
          }
        }
        for (const correction of project.corrections) {
          if (correction.status === "pending" && !alignActive.has(alignKey(dir, correction.id))) {
            void alignCorrectionJob(dir, correction.id, project.revision);
          }
        }
        let undoRevision: number | null = null;
        if (project.revision > 0) {
          const revision = project.revision - 1;
          const exists = await stat(join(dir, "history", `rev-${revision}.json`)).then(() => true, error => {
            if (error.code === "ENOENT") return false;
            throw error;
          });
          if (exists) undoRevision = (await readHistorySnapshot(dir, revision)).revision;
        }
        const fps=project.assembly.fps.num/project.assembly.fps.den;
        const candidates=brollCandidates(project).map(candidate=>({...candidate,entries:candidateSupport(project,candidate,0,Math.round(candidate.end*fps)-Math.round(candidate.start*fps))}));
        sendJson(res, {
          project, undoRevision,
          templateProposal:await readTemplateProposal(),
          speechProposal: await readSpeechProposal(),
          supportSwap: await readSupportSwap(),
          rhythmProposal: await readRhythmProposal(),
          rhythmProfiles: RHYTHM_PROFILES,
          // Relatório da receita aceita (#68): leitura local, sem análise paga.
          templateReport: buildTemplateReport(project),
          brollCandidates: candidates,
          verificacao: await readVerification(dir, project.revision),
          ...snapshot(),
        });
        return true;
      }

      if (parts[1] === "media" && req.method === "GET") {
        const sourceId = decodeURIComponent(parts[2] ?? "");
        const project = await loadProject(dir);
        const source = project.assembly.sources.find((item) => item.id === sourceId);
        if (!source) throw new HttpError(404, "fonte não cadastrada");
        if (url.searchParams.get("view") === "playback") {
          try {
            const { videoPath } = await ensurePlayback(source, dir, deps.exec, { detectHardware: true });
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
          const thumbnailPath = await ensureThumbnail(source, dir, deps.exec);
          if (!thumbnailPath) throw new HttpError(404, "fonte sem miniatura (somente áudio)");
          await serveMedia(req, res, thumbnailPath, "image/jpeg");
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw mediaError(err);
        }
        return true;
      }

      if (parts[1] === "waveform" && req.method === "GET") {
        const sourceId = decodeURIComponent(parts[2] ?? "");
        const project = await loadProject(dir);
        const source = project.assembly.sources.find((item) => item.id === sourceId);
        if (!source) throw new HttpError(404, "fonte não cadastrada");
        // Sem peaks a faixa desenha só os blocos: 204, nunca erro.
        // Cache corrompido equivale a ausente (best-effort).
        try {
          const raw = await readFile(peaksPath(dir, source.sha256), "utf8");
          sendJson(res, JSON.parse(raw));
        } catch {
          res.writeHead(204);
          res.end();
        }
        return true;
      }

      if (parts[1] === "resolve-status" && req.method === "GET") {
        const project=await loadProject(dir); sendJson(res,{delivery:await readDelivery(dir,project.revision)}); return true;
      }
      if (parts[1] === "resolve-drp" && req.method === "GET") {
        const project=await loadProject(dir); const delivery=await readDelivery(dir,project.revision);
        if (!delivery?.drpPath) throw new HttpError(404,"DRP não registrado");
        await serveMedia(req,res,delivery.drpPath,"application/octet-stream");return true;
      }
      if (parts[1] === "output" && req.method === "GET") {
        const revision = parts[2] ?? "";
        const kind = parts[3] ?? "";
        const file = kind === "otio" ? "timeline.otio"
          : kind === "mp4" ? "reference.mp4"
          : kind === "instrucoes" ? "importar-no-resolve.txt"
          : kind === "verificacao" ? "verificacao.json" : "";
        if (!file) throw new HttpError(404, "saída desconhecida");
        const type = kind === "otio" || kind === "verificacao" ? "application/json"
          : kind === "instrucoes" ? "text/plain; charset=utf-8" : "video/mp4";
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
        abortOperations();
        livePreviews.clear();
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
            return bump(applyCanvasPolicy(addSource(loaded, source)));
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
          return bump(applyCanvasPolicy(next));
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
        const project = await mutate(baseRevision, (project) => {
          const assembly = project.assembly;
          const sourceId = body.sourceId === undefined ? undefined : String(body.sourceId);
          if (sourceId !== undefined) {
            const source = assembly.sources.find((item) => item.id === sourceId);
            if (!source) throw new HttpError(404, "fonte não cadastrada");
            if (!source.hasVideo) throw new HttpError(400, `fonte ${source.id} não tem vídeo`);
            const canvas = canvasForSource(source, assembly);
            return bump({
              ...project,
              assembly: {
                ...assembly, ...canvas,
                canvasSourceId: source.id,
                canvasManual: true,
              },
            });
          }
          const fpsRaw = body.fps as { num?: unknown; den?: unknown } | undefined;
          const width = Number(body.width);
          const height = Number(body.height);
          if (!fpsRaw || !Number.isSafeInteger(fpsRaw.num) || !Number.isSafeInteger(fpsRaw.den)
            || Number(fpsRaw.num) <= 0 || Number(fpsRaw.den) <= 0) {
            throw new HttpError(400, "fps inválido");
          }
          if (!Number.isSafeInteger(width) || width <= 0 || width % 2 !== 0) {
            throw new HttpError(400, "width precisa ser inteiro par positivo");
          }
          if (!Number.isSafeInteger(height) || height <= 0 || height % 2 !== 0) {
            throw new HttpError(400, "height precisa ser inteiro par positivo");
          }
          return bump({
            ...project,
            assembly: {
              ...assembly,
              fps: { num: Number(fpsRaw.num), den: Number(fpsRaw.den) },
              width,
              height,
              canvasSourceId: null,
              canvasManual: true,
            },
          });
        });
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
          try {
            const analysis = await analyzeSource(source, dir, deps.exec, { signal, speech: deps.speech });
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
          } catch (err) {
            if (isCancelledError(err) || signal.aborted) break;
            throw err;
          }
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
        const releaseHold = holdPreparation(dir);
        void runPreparation(
          dir,
          baseRevision,
          { mode, request, modelOptIn, visualOptIn },
          { decision: deps.decision, exec: deps.exec, proposeSend: deps.proposeSend, describeClient: deps.describeClient, speech: deps.speech },
          { signal, isCurrent: () => stillCurrent(gen) },
        ).finally(releaseHold).then(
          (result) => {
            if (!stillCurrent(gen)) return;
            const prep = result.preparation;
            operation = prep?.status === "cancelled" ? { stage: "cancelled" }
              : prep && prep.status !== "ready"
                ? { stage: "error", error: prep.error || "Preparação incompleta. Confira os materiais e retome." }
                : { stage: "ready" };
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

      if (parts[1] === "template-proposal" && req.method === "POST") {
        const expected=requireRevision(body);let project=await loadProject(dir);
        if(project.revision!==expected)throw new HttpError(409,"revisão desatualizada");
        if(project.preparation?.status==="running")throw new HttpError(409,"Aguarde ou cancele a preparação atual.");
        if(!deps.templatesRoot)throw new HttpError(409,"biblioteca de templates indisponível");
        const template=body.templateId===null?null:await loadRecipe(deps.templatesRoot,String(body.templateId),Number(body.templateRevision));
        if(template&&template.status!=="approved")throw new HttpError(409,"template não aprovado");
        if(!deps.proposeSend||!(deps.allowPaidModel||project.permissions.model||body.modelOptIn===true))throw new HttpError(402,PAID_BLOCKED);
        if(!project.assembly.sources.some(s=>s.included))throw new HttpError(409,"Importe os materiais do projeto primeiro.");
        const {gen,signal}=begin("proposing");
        try {
          for(const source of project.assembly.sources.filter(s=>s.included)) {
            if(project.analyses.some(a=>a.sourceId===source.id&&a.status==="ready"))continue;
            operation={stage:"analyzing",sourceId:source.id};
            if(source.hasVideo&&(!deps.describeClient||!(deps.allowPaidVisual||project.permissions.visual||body.visualOptIn===true)))throw new HttpError(402,PAID_BLOCKED);
            const analysis=await analyzeSource(source,dir,deps.exec,{signal,speech:deps.speech});
            if(analysis.status!=="ready")throw new HttpError(409,analysis.error||"análise incompleta");
            if(source.hasVideo){analysis.visual=await describeSource(source,dir,signal,{exec:deps.exec,client:deps.describeClient!});analysis.visualCoverage=visualCoverage(analysis.visual,source.durationSeconds);}
            project=await mutate(expected,p=>({...p,analyses:mergeAnalyses(p.analyses,[analysis])}));
          }
          const proposal=await proposeScenes(project,String(body.request??"Aplicar a receita editorial ao material disponível."),signal,{send:deps.proposeSend,decision:deps.decision,template});
          if(!stillCurrent(gen)||(await loadProject(dir)).revision!==expected)throw new HttpError(409,"revisão mudou durante a proposta");
          await publishAtomic(templateProposalPath,JSON.stringify(proposal));operation={stage:"ready"};
          sendJson(res,{project:await loadProject(dir),templateProposal:proposal,...snapshot()});
        }catch(error){if(stillCurrent(gen))operation={stage:"error",error:error instanceof Error?error.message:String(error)};throw error;}
        return true;
      }
      if ((parts[1] === "template-accept" || parts[1] === "template-reject") && req.method === "POST") {
        const expected=requireRevision(body);const proposal=await readTemplateProposal();
        if(!proposal||proposal.id!==body.proposalId||proposal.baseRevision!==expected)throw new HttpError(409,"proposta ausente ou desatualizada");
        let project=await loadProject(dir);if(project.revision!==expected)throw new HttpError(409,"revisão desatualizada");
        if(parts[1]==="template-accept")project=await mutate(expected,async p=>{await writeHistorySnapshot(dir,p);return applyProposal(p,proposal);});
        // Preserve a newer candidate if another generation finished concurrently.
        if((await readTemplateProposal())?.id===proposal.id)await unlink(templateProposalPath).catch(()=>{});
        sendJson(res,{project,templateProposal:null,...snapshot()});return true;
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
            send: deps.proposeSend, decision: deps.decision,
          });
          if (!stillCurrent(gen)) return project;
          operation = { stage: "ready" };
          return { ...project, proposal };
        });
        sendJson(res, { project, ...snapshot() });
        return true;
      }

      // Ajuste localizado de fala (#64): proposta só cobre a fala
      // escolhida; aceitar/rejeitar usam o arquivo sidecar e a revisão.
      if (parts[1] === "speech-proposal" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const sourceId = String(body.sourceId ?? "");
        const speechId = String(body.speechId ?? "");
        const request = String(body.request ?? "");
        if (!sourceId || !speechId) {
          throw new HttpError(400, "selecione a fala a ajustar");
        }
        const loaded = await loadProject(dir);
        if (loaded.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${loaded.revision}`);
        }
        // Permissão gravada no projeto conta como opt-in — o gate usa o
        // estado carregado, não só a flag do processo.
        if (!deps.proposeSend || !(deps.allowPaidModel || loaded.permissions.model || body.modelOptIn === true)) {
          throw new HttpError(402, PAID_BLOCKED);
        }
        const { gen, signal } = begin("proposing");
        try {
          const proposal = await proposeSpeechAdjustment(
            loaded, { sourceId, speechId }, request, deps.proposeSend, signal,
          );
          if (!stillCurrent(gen)) {
            sendJson(res, { project: await loadProject(dir), ...snapshot() });
            return true;
          }
          // A proposta espera o modelo fora da trava de mutação: se a revisão
          // andou enquanto o modelo pensava, descarta em vez de publicar uma
          // proposta já velha.
          const latest = await loadProject(dir);
          if (latest.revision !== proposal.baseRevision) {
            operation = { stage: "ready" };
            sendJson(res, { project: latest, speechProposal: null, ...snapshot() });
            return true;
          }
          await publishAtomic(speechProposalPath, `${JSON.stringify(proposal)}\n`);
          operation = { stage: "ready" };
          sendJson(res, {
            project: latest, speechProposal: proposal, ...snapshot(),
          });
        } catch (err) {
          operation = { stage: "idle" };
          const message = err instanceof Error ? err.message : String(err);
          if (/fora do escopo|não encontrada|sem análise|não está na montagem|inválido|sem wordIds|sem lista/.test(message)) {
            throw new HttpError(400, message);
          }
          throw err;
        }
        return true;
      }

      if (parts[1] === "speech-accept" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const proposalId = String(body.proposalId ?? "");
        const proposal = await readSpeechProposal();
        if (!proposal || proposal.id !== proposalId || proposal.baseRevision !== baseRevision) {
          throw new HttpError(409, "proposta ausente ou desatualizada");
        }
        const project = await mutate(baseRevision, async (loaded) => {
          await writeHistorySnapshot(dir, loaded);
          return applySpeechProposal(loaded, proposal);
        });
        await unlink(speechProposalPath).catch(() => {});
        sendJson(res, { project, speechProposal: null, ...snapshot() });
        return true;
      }

      if (parts[1] === "speech-reject" && req.method === "POST") {
        const proposalId = String(body.proposalId ?? "");
        const proposal = await readSpeechProposal();
        // Rejeitar só exige a identidade da proposta: ela precisa continuar
        // dispensável mesmo desatualizada (a recusa por revisão vale para
        // aceitar, nunca para descartar).
        if (!proposal || proposal.id !== proposalId) {
          throw new HttpError(409, "proposta ausente");
        }
        await unlink(speechProposalPath).catch(() => {});
        sendJson(res, { project: await loadProject(dir), speechProposal: null, ...snapshot() });
        return true;
      }

      if (parts[1] === "support-swap" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const sceneId = String(body.sceneId ?? "");
        const supportIndex = Number(body.supportIndex);
        const request = String(body.request ?? "");
        if (!sceneId || !Number.isSafeInteger(supportIndex) || supportIndex < 0) {
          throw new HttpError(400, "selecione o apoio a trocar");
        }
        const loaded = await loadProject(dir);
        if (loaded.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${loaded.revision}`);
        }
        let proposal: SupportSwapProposal;
        try {
          proposal = buildSupportSwapProposal(loaded, { sceneId, supportIndex }, request);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        await publishAtomic(supportSwapPath, `${JSON.stringify(proposal)}\n`);
        sendJson(res, { project: await loadProject(dir), supportSwap: proposal, ...snapshot() });
        return true;
      }

      if (parts[1] === "support-swap-accept" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const proposalId = String(body.proposalId ?? "");
        const candidateId = String(body.candidateId ?? "");
        const proposal = await readSupportSwap();
        if (!proposal || proposal.id !== proposalId || proposal.baseRevision !== baseRevision) {
          throw new HttpError(409, "proposta ausente ou desatualizada");
        }
        let project: Project;
        try {
          project = await mutate(baseRevision, async (loaded) => {
            await writeHistorySnapshot(dir, loaded);
            return applySupportSwap(loaded, proposal, candidateId);
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/não é elegível|fora da proposta|não existe mais|não encontrada|inexistente/.test(message)) {
            throw new HttpError(400, message);
          }
          throw err;
        }
        await unlink(supportSwapPath).catch(() => {});
        sendJson(res, { project, supportSwap: null, ...snapshot() });
        return true;
      }

      if (parts[1] === "support-swap-reject" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const proposalId = String(body.proposalId ?? "");
        const proposal = await readSupportSwap();
        if (!proposal || proposal.id !== proposalId || proposal.baseRevision !== baseRevision) {
          throw new HttpError(409, "proposta ausente ou desatualizada");
        }
        await unlink(supportSwapPath).catch(() => {});
        sendJson(res, { project: await loadProject(dir), supportSwap: null, ...snapshot() });
        return true;
      }

      // Controle de ritmo (#66): proposta determinística (sem modelo pago)
      // — comparação por pausa + amostra auditável renderizada pela linha
      // de prévia; aceitar/rejeitar seguem o fluxo de propostas localizadas.
      if (parts[1] === "rhythm-proposal" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const loaded = await loadProject(dir);
        if (loaded.revision !== baseRevision) {
          throw new HttpError(409, `revisão desatualizada: base ${baseRevision}, atual ${loaded.revision}`);
        }
        let proposal: RhythmProposal;
        try {
          proposal = buildRhythmProposal(loaded, rhythmProfile(String(body.profileId ?? "")).id);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        await publishAtomic(rhythmProposalPath, `${JSON.stringify(proposal)}\n`);
        sendJson(res, { project: loaded, rhythmProposal: proposal, ...snapshot() });
        return true;
      }

      if (parts[1] === "rhythm-sample" && req.method === "GET") {
        const proposalId = parts[2] ?? "";
        const which = parts[3] === "depois" ? "depois" : "antes";
        const proposal = await readRhythmProposal();
        const project = await loadProject(dir);
        if (!proposal || proposal.id !== proposalId || proposal.baseRevision !== project.revision) {
          throw new HttpError(409, "proposta ausente ou desatualizada");
        }
        const assembly = rhythmSampleAssembly(project, proposal, which);
        if (!assembly) throw new HttpError(404, "amostra indisponível: a proposta não tem trecho com pausa");
        const rendered = await renderAssembly(assembly, join(dir, "rhythm-samples"), deps.exec, {
          profile: "software",
        });
        await serveMedia(req, res, rendered, "video/mp4");
        return true;
      }

      if (parts[1] === "rhythm-accept" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const proposalId = String(body.proposalId ?? "");
        const proposal = await readRhythmProposal();
        if (!proposal || proposal.id !== proposalId || proposal.baseRevision !== baseRevision) {
          throw new HttpError(409, "proposta ausente ou desatualizada");
        }
        const project = await mutate(baseRevision, async (loaded) => {
          await writeHistorySnapshot(dir, loaded);
          return applyRhythmProposal(loaded, proposal);
        });
        await unlink(rhythmProposalPath).catch(() => {});
        sendJson(res, { project, rhythmProposal: null, ...snapshot() });
        return true;
      }

      if (parts[1] === "rhythm-reject" && req.method === "POST") {
        const proposalId = String(body.proposalId ?? "");
        const proposal = await readRhythmProposal();
        // Rejeitar dispensa a proposta pela identidade — desatualizada
        // também sai (a recusa por revisão vale para aceitar).
        if (!proposal || proposal.id !== proposalId) {
          throw new HttpError(409, "proposta ausente");
        }
        await unlink(rhythmProposalPath).catch(() => {});
        sendJson(res, { project: await loadProject(dir), rhythmProposal: null, ...snapshot() });
        return true;
      }

      if (parts[1] === "apply" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const proposalId = String(body.proposalId ?? "");
        const project = await mutate(baseRevision, async (project) => {
          if (!project.proposal || project.proposal.id !== proposalId) {
            throw new HttpError(409, "proposta ausente ou desatualizada");
          }
          await writeHistorySnapshot(dir, project);
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
        const { gen, signal, settle } = beginPreview();
        try {
          const project = await mutate(baseRevision, async (project) => {
            let reference: string;
            try {
              reference = await renderAssembly(project.assembly, dir, deps.exec, { detectHardware: true, signal });
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
        } finally {
          settle();
        }
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

      if ((parts[1] === "deliver-resolve" || parts[1] === "export-drp") && req.method === "POST") {
        const expected=requireRevision(body);const project=await loadProject(dir);
        if(project.revision!==expected)throw new HttpError(409,"revisão desatualizada");
        try {
          const delivery=await deliverApproved(project,dir,deps.exec,new AbortController().signal,{exportDrp:parts[1]==="export-drp",newCopy:body.newCopy===true});
          sendJson(res,{project:await loadProject(dir),delivery});
        } catch(error) {throw new HttpError(409,error instanceof Error?error.message:String(error));}
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
          sendJson(res, {
            project: loaded, path: dest,
            verificacao: await readVerification(dir, loaded.revision),
            ...snapshot(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/aprovação final|mídia ausente|substitu|absoluto|andamento|prévia|mudou durante|timecode ilegível/.test(message)) {
            throw new HttpError(409, message);
          }
          throw err;
        }
        return true;
      }

      // Conferência de importação (#63): confirmação manual sobre a
      // entrega íntegra da revisão atual. Exportar nunca confirma;
      // revisão nova começa sem verificacao.json (não herda).
      if (parts[1] === "verify-import" && req.method === "POST") {
        const baseRevision = requireRevision(body);
        const project = await mutate(baseRevision, async (loaded) => {
          try {
            await confirmImportVerification(loaded, dir);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/entrega íntegra/.test(message)) throw new HttpError(409, message);
            throw err;
          }
          return loaded;
        });
        sendJson(res, {
          project,
          verificacao: await readVerification(dir, project.revision),
          ...snapshot(),
        });
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
