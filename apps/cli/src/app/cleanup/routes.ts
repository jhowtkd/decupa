import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { hashFile, probe } from "@decupa/media";
import { buildEdl } from "../edl.ts";
import { buildOtio } from "../assembly/otio.ts";
import type { Assembly } from "../assembly/types.ts";
import { FillerRequestError, type createCleanupPlanning } from "../../condense/cleanup-planning.ts";
import { serveMedia } from "../../http/media.ts";
import {
  audioProxyPath, keepListError, planPath, probeFps, probeSourceStartSeconds,
  runRender, transcriptPath, type Executor, type PipelineJob,
} from "../pipeline.ts";
import { sourceMismatch } from "../session.ts";
import { projectUrl } from "../project-url.ts";
import { parseSourceTimecode } from "../assembly/timecode.ts";
import { buildSrt, type SrtWord } from "../srt.ts";
import { analysisClientOptions, type Credentials } from "@decupa/triage";
import { JobStore, type Job } from "../jobs.ts";
import type { FileCoordinator } from "@decupa/coordinator";
import { handleReservationRequest, requireEditReservation } from "../edit-reservation.ts";

export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("corpo do pedido excede 1 MiB");
  }
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

function parseRequestUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

type CleanupPlanning = ReturnType<typeof createCleanupPlanning>;

export interface CleanupRuntimeDeps {
  input: string;
  workDir: string;
  displayName?: string;
  prefix?: string;
  provider?: string;
  providerConfigDir?: string;
  fetchImpl?: typeof fetch;
  visualEnv: Record<string, string | undefined>;
  exec: Executor;
  pipelineJob: PipelineJob;
  job: Job;
  store: JobStore;
  cleanup: CleanupPlanning;
  ingestAbort: AbortController;
  audioReady: () => boolean;
  loadStored: () => Promise<Credentials | null>;
  page: () => Promise<string>;
  replan: (keepList?: string) => Promise<void>;
  triageReply: () => Promise<Record<string, unknown>>;
  triageRequestKey: () => Promise<string>;
  otioClipsForPlan: (clips: { start: number; end: number }[], fps: number, durationSeconds: number) => Assembly["tracks"][number]["clips"];
  coordinator?: FileCoordinator;
  now?: () => number;
  identity?: (req: IncomingMessage) => string | undefined;
  busy?: () => boolean;
}

export interface CleanupRuntime {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
  isBusy(): boolean;
}

export function createCleanupRuntime(opts: CleanupRuntimeDeps): CleanupRuntime {
  const {
    input, workDir, exec, pipelineJob, job, store, cleanup, ingestAbort,
    loadStored, page, replan, triageReply, triageRequestKey, otioClipsForPlan,
  } = opts;
  let triageFlight: { key: string; reply: Promise<Record<string, unknown>> } | null = null;
  /** Fila de uma vaga: cada chamada espera a anterior terminar. */
  function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
    let tail = Promise.resolve();
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    };
  }
  const serializeMp4Export = serialQueue();
  // O plano em disco é um só por Limpeza. Regerar e ler precisam ser atômicos
  // em relação a outro /keep: um keep entre o replan do export e a leitura
  // trocaria o corte que o export entrega. Os cacoetes ficam fora de propósito:
  // a fila do planejamento funde keep e cacoetes sobrepostos, e um cacoete
  // decidido no meio não muda o keep-list pedido pelo export.
  const withPlan = serialQueue();

  return {
    isBusy: () => {
      const stage = store.get(job.id)?.stage;
      const active = opts.busy
        ? opts.busy()
        : Boolean(stage && !["ready", "error", "cancelled"].includes(stage));
      // Num job cancelado ou com erro o store ignora novas mutações, então a
      // marca de notas pendentes pode ficar presa em true; ali as notas já foram
      // canceladas junto com o job e não seguram o Projeto na memória.
      const terminal = stage === "cancelled" || stage === "error";
      return active || triageFlight !== null || (!terminal && Boolean(store.get(job.id)?.fillerNotesPending));
    },
    handle: async (req, res): Promise<boolean> => {
      const url = parseRequestUrl(req.url);
      if (!url) { sendJson(res, { error: "URL inválida" }, 400); return true; }
      const reservationDeps = {
        projeto: opts.workDir,
        now: opts.now ?? Date.now,
        identity: opts.identity ?? (() => undefined),
      };
      if (await handleReservationRequest(req, res, reservationDeps)) return true;
      if (req.method !== "GET" && url.pathname.startsWith("/jobs")
        && !await requireEditReservation(req, res, reservationDeps)) return true;
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await page());
        return true;
      }

      if (["/keeplist.js", "/fillers-ui.js", "/review-generation.js", "/project-path.js", "/edit-reservation-ui.js"].includes(url.pathname)) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(await readFile(new URL(`../${url.pathname.slice(1)}`, import.meta.url), "utf8"));
        return true;
      }

      if (url.pathname === "/media/audio") {
        if (!opts.audioReady()) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("proxy de áudio ainda não existe");
          return true;
        }
        await serveMedia(req, res, audioProxyPath(pipelineJob), "audio/mp4");
        return true;
      }

      if (url.pathname === "/media") {
        try {
          await serveMedia(req, res, input);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("mídia não encontrada");
            return true;
          }
          throw error;
        }
        return true;
      }

      if (parts[0] !== "jobs" || !parts[1]) return false;
      let current = store.get(parts[1]);
      if (!current) { sendJson(res, { error: "job não existe" }, 404); return true; }

      if (parts.length === 2 && req.method === "GET") {
        await cleanup.refreshNotes();
        current = store.get(parts[1])!;
        sendJson(res, {
          stage: current.stage, error: current.error, warning: [current.warning, current.fillerWarning].filter(Boolean).join("; ") || undefined,
          fillerWarning: current.fillerWarning, fillerNotesPending: current.fillerNotesPending ?? false, planning: cleanup.planning(),
          progress: current.progress,
          keepList: current.keepList, review: current.review,
          generation: current.review?.generation ?? 0, desiredGeneration: cleanup.generation(), fillerNotes: current.fillerNotes,
          source: opts.displayName ?? basename(input),
          audio: opts.audioReady(),
        });
        return true;
      }

      if (parts[2] === "cancel" && req.method === "POST") {
        store.cancel(current.id);
        ingestAbort.abort();
        sendJson(res, { ok: true });
        return true;
      }

      if (parts[2] === "keep" && req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.keepList !== "string") {
          sendJson(res, { error: "keepList precisa ser string, no formato \"u001-u003 u005\"" }, 400);
          return true;
        }
        const invalid = keepListError(body.keepList);
        if (invalid) { sendJson(res, { error: invalid }, 400); return true; }
        await withPlan(() => replan(body.keepList as string));
        sendJson(res, { review: store.get(current.id)!.review });
        return true;
      }

      if (parts[2] === "fillers" && req.method === "POST") {
        const body = await readBody(req);
        try { await cleanup.fillers(body); }
        catch (error) {
          if (error instanceof FillerRequestError) { sendJson(res, { error: error.message }, error.status); return true; }
          throw error;
        }
        sendJson(res, { review: store.get(current.id)!.review });
        return true;
      }

      if (parts[2] === "triage" && req.method === "POST") {
        if (opts.providerConfigDir) {
          try { analysisClientOptions({ env: opts.visualEnv, stored: await loadStored() }); }
          catch { sendJson(res, { error: "Configure o provedor de texto primeiro" }, 428); return true; }
        }
        const mismatch = await sourceMismatch(workDir, input);
        if (mismatch) { sendJson(res, { error: mismatch }, 409); return true; }
        const key = await triageRequestKey();
        if (triageFlight && triageFlight.key !== key) {
          sendJson(res, {
            error: "já há uma triagem em andamento com outros parâmetros (fonte, índice ou provedor). " +
              "Espere ela terminar e peça de novo.",
          }, 409);
          return true;
        }
        if (!triageFlight) {
          const flight = { key, reply: triageReply() };
          triageFlight = flight;
          void flight.reply.finally(() => {
            if (triageFlight === flight) triageFlight = null;
          }).catch(() => {});
        }
        sendJson(res, await triageFlight.reply);
        return true;
      }

      if (parts[2] === "export" && req.method === "POST") {
        const body = await readBody(req);
        const kind = String(body.kind ?? "");
        const mismatch = await sourceMismatch(workDir, input);
        if (mismatch) { sendJson(res, { error: mismatch }, 409); return true; }
        if (typeof body.keepList === "string") {
          const invalid = keepListError(body.keepList);
          if (invalid) { sendJson(res, { error: invalid }, 400); return true; }
        }
        const plan = await withPlan(async () => {
          if (typeof body.keepList === "string") await replan(body.keepList);
          return JSON.parse(await readFile(planPath(pipelineJob), "utf8")) as Record<string, any>;
        });

        if (kind === "edl") {
          const fps = await probeFps(pipelineJob, exec, { allowDropFrame: true });
          const startSeconds = await probeSourceStartSeconds(pipelineJob, exec);
          const out = join(workDir, "corte.edl");
          await writeFile(out, buildEdl({
            clips: plan.clips, fps, title: basename(input),
            sourceStartFrames: Math.round(startSeconds * fps),
          }), "utf8");
          sendJson(res, { path: out, downloadUrl: projectUrl(`jobs/${current.id}/download/edl`, opts.prefix) });
          return true;
        }
        if (kind === "otio") {
          const info = await probe(input);
          const rate = info.frameRate;
          if (!rate) throw new Error("fonte sem frame rate para exportar OTIO");
          const fps = rate.num / rate.den;
          const durationSeconds = Math.max(info.durationMs / 1000, 0.001);
          const clips = plan.clips as { start: number; end: number }[];
          const videoClips = otioClipsForPlan(clips, fps, durationSeconds);
          const width = info.width;
          const height = info.height;
          if (!width || !height || width % 2 !== 0 || height % 2 !== 0) throw new Error("fonte com canvas inválido para exportar OTIO");
          const sha256 = await hashFile(input);
          const audioClips = videoClips.map((clip, i) => ({ ...clip, id: `a_c${i + 1}` }));
          const assembly: Assembly = {
            version: 1, revision: 1, name: basename(input), fps: rate, width, height,
            sources: [{
              id: "src1", path: resolve(input), sha256, durationSeconds,
              hasVideo: info.hasVideo, hasAudio: info.hasAudio, fps: rate, width, height,
              timecode: info.timecode ? parseSourceTimecode(info.timecode, rate) : null,
              role: "speech", included: true, name: basename(input),
            }],
            tracks: [
              { kind: "Video", name: "V1", clips: info.hasVideo ? videoClips : [] },
              { kind: "Video", name: "V2", clips: [] },
              { kind: "Audio", name: "A1", clips: info.hasAudio ? audioClips : [] },
            ],
          };
          const out = join(workDir, "corte.otio");
          await writeFile(out, `${buildOtio(assembly)}\n`, "utf8");
          sendJson(res, { path: out, downloadUrl: projectUrl(`jobs/${current.id}/download/otio`, opts.prefix) });
          return true;
        }
        if (kind === "mp4") {
          const out = join(workDir, "corte.mp4");
          // O plano é um snapshot do clique. O arquivo compartilhado pode mudar
          // enquanto este export espera a fila global.
          const exportDir = await mkdtemp(join(workDir, ".decupa-export-"));
          try {
            await mkdir(join(exportDir, "out"), { recursive: true });
            await writeFile(join(exportDir, "out", "condense_plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
            // O render entra na fila global, mas não mexe no estágio do job: ele
            // descreve a preparação da Mídia, e o export é uma requisição à parte
            // que a tela já acompanha enquanto espera a resposta. Exports do
            // mesmo Projeto são serializados porque compartilham corte.mp4.
            await serializeMp4Export(() => runRender({ ...pipelineJob, workDir: exportDir }, out, exec, opts.coordinator));
          } finally {
            await rm(exportDir, { recursive: true, force: true });
          }
          sendJson(res, { path: out, downloadUrl: projectUrl(`jobs/${current.id}/download/mp4`, opts.prefix) });
          return true;
        }
        if (kind === "srt") {
          const transcript = await JSON.parse(await readFile(transcriptPath(pipelineJob), "utf8")) as {
            segments?: { words?: { text?: unknown; start?: unknown; end?: unknown }[] }[];
          };
          const words = (transcript.segments ?? [])
            .flatMap((s) => s.words ?? [])
            .flatMap((w): SrtWord[] => {
              if (typeof w.text !== "string" || typeof w.start !== "number" || !Number.isFinite(w.start)
                || typeof w.end !== "number" || !Number.isFinite(w.end)) return [];
              return [{ text: w.text, startMs: Math.round(w.start * 1_000), endMs: Math.round(w.end * 1_000) }];
            });
          const out = join(workDir, "corte.srt");
          await writeFile(out, buildSrt({ clips: plan.clips, words }), "utf8");
          sendJson(res, { path: out, downloadUrl: projectUrl(`jobs/${current.id}/download/srt`, opts.prefix) });
          return true;
        }
        if (kind === "transcript") {
          sendJson(res, { path: join(workDir, "out", "condensed_transcript.json"), downloadUrl: projectUrl(`jobs/${current.id}/download/transcript`, opts.prefix) });
          return true;
        }
        sendJson(res, { error: `kind desconhecido: ${kind}` }, 400);
        return true;
      }

      if (parts[2] === "download" && parts[3]) {
        const files: Record<string, string> = {
          edl: join(workDir, "corte.edl"), otio: join(workDir, "corte.otio"), mp4: join(workDir, "corte.mp4"),
          srt: join(workDir, "corte.srt"), transcript: join(workDir, "out", "condensed_transcript.json"),
        };
        const path = files[parts[3]];
        if (!path) { sendJson(res, { error: "arquivo desconhecido" }, 404); return true; }
        const { size } = await stat(path);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${basename(path)}"`,
          "content-length": size,
        });
        await pipeline(createReadStream(path), res);
        return true;
      }

      return false;
    },
    close: async (): Promise<void> => {
      store.cancel(job.id);
      await cleanup.close();
    },
  };
}
