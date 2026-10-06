import { createTemplateRuntime } from "./templates/routes.ts";
import { homedir } from "node:os";
import { createFileCoordinator } from "@decupa/coordinator";
import { hashFile, probe } from "@decupa/media";
import { collectSink, createTracer } from "@decupa/trace";
import { createResidentSpeechClient } from "@decupa/transcript";
import { createCredentialsReader, installCompanyCredentials, readAnalysisCredentials, resolveAssemblyTextProvider, resolveVisualProvider } from "@decupa/triage";
import { resolveAppTransports } from "./analysis-transports.ts";
import { providerSetup } from "./provider-setup.ts";
import { keyProviderState, providerVisual, withVisualNotice } from "./provider-visual.ts";
import { operationResolver } from "./analysis-operation.ts";
import { cancelAssemblyFillerNotes } from "./assembly/filler-observe.ts";
import { createReadStream } from "node:fs";
import { readFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { serveMedia } from "../http/media.ts";
import { guardLocalRequest, originAllowed } from "../http/origin.ts";
import { buildEdl } from "./edl.ts";
import { buildOtio } from "./assembly/otio.ts";
import type { Assembly } from "./assembly/types.ts";
import { JobStore } from "./jobs.ts";
import { createCleanupPlanning, FillerRequestError } from "../condense/cleanup-planning.ts";
import {
  assertSidecarSynced, audioProxyPath, ensureAudioProxy, indexPath, keepListError, planPath, preflight, probeFps,
  probeSourceStartSeconds, runIngest, runRender, runTriage, SPEECH_SCRIPT, SpawnExecutor, transcriptPath,
  visualIndexPath, type Executor, type IngestSpeech, type PipelineJob,
} from "./pipeline.ts";
import { triageIdentity } from "../triage.ts";
import { parseSourceTimecode } from "./assembly/timecode.ts";
import type { ReviewUnitFlag } from "./review.ts";
import { buildSrt, type SrtWord } from "./srt.ts";
import { editorialStats } from "./stats.ts";
import { claimWorkDir, cleanupWorkDir, sourceMismatch } from "./session.ts";
import { createAssemblyRuntime, type AssemblyDeps } from "./assembly/routes.ts";
import type { VisualClient } from "./assembly/model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Motivos da prévia: só o que o modelo aplicou. Rejeitado usa o mesmo
 *  `- **ids**` e não pode aparecer como justificativa de corte. */
function motivosFromReport(report: string): string[] {
  const motivos: string[] = [];
  let section: "aplicado" | "rejeitado" | "other" = "other";
  for (const line of report.split("\n")) {
    if (line.startsWith("#")) {
      if (/^###\s+Aplicado\b/.test(line)) section = "aplicado";
      else if (/^###\s+Rejeitado\b/.test(line)) section = "rejeitado";
      else section = "other";
      continue;
    }
    const clean = () => line.replace(/^-\s*/, "").replace(/\*\*/g, "");
    if (section === "aplicado" && line.startsWith("- **")) {
      motivos.push(clean());
      continue;
    }
    if (
      section !== "rejeitado"
      && line.startsWith("- **")
      && line.includes("(rank")
      && !line.includes("~~")
    ) {
      motivos.push(clean());
    }
  }
  return motivos;
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

/** Os corpos da limpeza são um keep-list e um `kind`: 1 MiB sobra. Sem teto,
 *  um POST gigante enche a memória do processo que segura os jobs. */
export const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("corpo do pedido excede 1 MiB");
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new BodyTooLargeError();
  // Sem content-length, drena até o fim antes de recusar: largar o stream no
  // meio derruba o socket e o 413 nunca chega.
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function maybeVisual(job: PipelineJob): Promise<unknown | undefined> {
  try {
    return await readJson(visualIndexPath(job));
  } catch {
    return undefined;
  }
}

async function maybeInspectFlags(workDir: string): Promise<Record<string, ReviewUnitFlag[]>> {
  try {
    const raw = await readJson(join(workDir, "out", "triage.json")) as {
      reviewFlags?: { unitId: string; code: string; source: string; message: string }[];
    };
    const map: Record<string, ReviewUnitFlag[]> = {};
    for (const f of raw.reviewFlags ?? []) {
      (map[f.unitId] ??= []).push({ code: f.code, source: f.source, message: f.message });
    }
    return map;
  } catch {
    return {};
  }
}

export interface AppHandle {
  port: number;
  address: string;
  jobId: string;
  close(): Promise<void>;
  /** SIGKILL síncrono no que restar de filho: o handler de `exit` do CLI só
   *  roda código síncrono e não tem como esperar a escalada do `close()`. */
  killChildren(): void;
}

export function attachResidentSpeech(opts: {
  dir: string;
  speech?: IngestSpeech;
  executorInjected: boolean;
}): { speech?: IngestSpeech; closeSpeech: () => Promise<void> } {
  if (opts.speech) return { speech: opts.speech, closeSpeech: async () => undefined };
  if (opts.executorInjected) return { closeSpeech: async () => undefined };
  const client = createResidentSpeechClient();
  const coordinator = createFileCoordinator(join(opts.dir, ".decupa", "coordinator"), { limit: 1 });
  // O worker sobe com `uv run --no-sync`: sem o venv da fala sincronizado a
  // montagem (que não passa pelo preflight da limpeza) quebraria só na
  // primeira transcrição, com um ModuleNotFoundError cru. Confere uma vez;
  // falha não fica em cache, para o setup poder ser feito com o app aberto.
  let synced: Promise<void> | undefined;
  const ensureSynced = (): Promise<void> => {
    synced ??= assertSidecarSynced(new SpawnExecutor(), dirname(SPEECH_SCRIPT), "fala")
      .catch((error: unknown) => { synced = undefined; throw error; });
    return synced;
  };
  return {
    speech: { worker: async (req) => { await ensureSynced(); return client.transcribe(req); }, coordinator },
    closeSpeech: () => client.close(),
  };
}

export async function startApp(opts: {
  input?: string;
  projectDir?: string;
  inputs?: string[];
  port?: number;
  providerConfigDir?: string;
  templatesRoot?: string;
  provider?: string;
  executor?: Executor;
  /** false nos testes: não dispara o pipeline de verdade. */
  autoStart?: boolean;
  /** só nos testes; em produção é derivado do caminho do vídeo. */
  workDir?: string;
  /** Mesma injeção do pipeline.runTriage: os testes do server substituem a
   *  chamada de biblioteca, que exigiria provider e índice de verdade. */
  triageFn?: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
    signal?: AbortSignal;
  }) => Promise<{ keepList: string }>;
  selectFn?: AssemblyDeps["selectFn"];
  proposeSend?: (content: unknown[], signal?: AbortSignal) => Promise<string>;
  describeClient?: VisualClient;
  /** Autorização explícita; desligada por padrão. Não dispara chamada sozinha. */
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  /** Worker residente injetável; em produção o serviço cria um `worker.py --serve`. */
  speech?: IngestSpeech;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  decisionLog?: (line: string) => void;
}): Promise<AppHandle> {
  resolveVisualProvider(opts.env ?? process.env);
  if (opts.projectDir && !opts.input) {
    return startAssemblyApp(opts as typeof opts & { projectDir: string });
  }
  if (!opts.input) throw new Error("startApp precisa de input ou projectDir");
  return startCleanupApp({ ...opts, input: opts.input });
}

/** Clipes OTIO a partir do plano: recusa o que passa da fonte e descarta
 *  cauda 100% sub-frame no EOF em vez de emitir 1 frame inválido. */
export function otioClipsForPlan(
  clips: { start: number; end: number }[],
  fps: number,
  durationSeconds: number,
): Assembly["tracks"][number]["clips"] {
  const overflow = clips.find((clip) => clip.end > durationSeconds + 1e-9);
  if (overflow) {
    throw new Error(
      `clipe [${overflow.start}, ${overflow.end}) ultrapassa a fonte (${durationSeconds}s)`,
    );
  }
  const videoClips: Assembly["tracks"][number]["clips"] = [];
  let cursor = 0;
  clips.forEach((clip, i) => {
    const maxFrames = Math.max(0, Math.floor((durationSeconds - clip.start) * fps));
    if (maxFrames === 0) return;
    const durationFrames = Math.min(Math.max(1, Math.round((clip.end - clip.start) * fps)), maxFrames);
    videoClips.push({
      id: `v_c${i + 1}`,
      sceneId: `scene_${i + 1}`,
      sourceId: "src1",
      sourceStartSeconds: clip.start,
      durationFrames,
      startFrame: cursor,
    });
    cursor += durationFrames;
  });
  return videoClips;
}

async function startCleanupApp(opts: {
  input: string;
  port?: number;
  providerConfigDir?: string;
  templatesRoot?: string;
  provider?: string;
  executor?: Executor;
  autoStart?: boolean;
  workDir?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  speech?: IngestSpeech;
  triageFn?: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
    signal?: AbortSignal;
  }) => Promise<{ keepList: string }>;
}): Promise<AppHandle> {
  if (opts.providerConfigDir) {
    await installCompanyCredentials(opts.providerConfigDir, opts.env ?? process.env);
  }
  const input = resolve(opts.input);
  const exec = opts.executor ?? new SpawnExecutor();
  const provider = opts.provider;
  const visualEnv = { ...(opts.env ?? process.env) };
  resolveAssemblyTextProvider(visualEnv); // Campo inválido falha na subida, antes de qualquer envio.
  const visualDir = opts.providerConfigDir ?? homedir();
  const readStored = createCredentialsReader();
  const loadStored = () => readAnalysisCredentials(process.cwd(), visualDir, readStored);
  const page = await readFile(join(HERE, "page.html"), "utf8");

  const workDir = opts.workDir ?? cleanupWorkDir(input);
  // Antes do coordenador e de qualquer leitura: ele mora dentro da pasta, e
  // uma pasta de outra fonte vai inteira para o lado. O ingest roda uma vez
  // por processo, então conferir aqui cobre todo reuso da sessão.
  const { staleDir } = await claimWorkDir(workDir, input);
  if (staleDir) console.log(`a fonte mudou desde a última sessão; os arquivos antigos foram para ${staleDir}`);
  await mkdir(join(workDir, "out"), { recursive: true });
  const { speech, closeSpeech } = attachResidentSpeech({
    dir: workDir,
    speech: opts.speech,
    executorInjected: Boolean(opts.executor),
  });
  const ingestAbort = new AbortController();

  const store = new JobStore();
  const job = store.create({ videoPath: input, workDir });
  const pipelineJob: PipelineJob = { id: job.id, videoPath: input, workDir, signal: store.signal(job.id) };
  const traces = collectSink();
  const tracer = createTracer(traces);

  const cleanup = createCleanupPlanning({ job: pipelineJob, exec, tracer, store,
    env: opts.env ?? process.env, fetchImpl: opts.fetchImpl, providerConfigDir: opts.providerConfigDir, loadStored,
    visual: () => maybeVisual(pipelineJob), flags: () => maybeInspectFlags(workDir) });
  const replan = cleanup.replan;

  // Proxy só de áudio para os botões "ouvir": gerado em paralelo ao ingest,
  // a página passa a usá-lo quando o poll avisa (`audio: true`).
  let audioReady = false;

  async function ingest(): Promise<void> {
    void ensureAudioProxy(pipelineJob, exec).then((ok) => { audioReady = ok; }, () => {});
    try {
      await preflight(pipelineJob, exec);
      const ingestResult = await runIngest(
        pipelineJob,
        exec,
        (stage) => store.setStage(job.id, stage),
        (line) => store.setProgress(job.id, line),
        tracer,
        speech,
        ingestAbort.signal,
        { requireSpeech: true },
      );
      if (ingestResult.warning) store.setWarning(job.id, ingestResult.warning);
      if (store.get(job.id)?.stage === "cancelled") return;
      // A recuperação do par acontece antes de escolher o keep-list retomado.
      await replan();
    } catch (error) {
      // `fail` não sobrescreve `cancelled`: matar o processo faz a etapa
      // falhar, e esse erro não é notícia para quem pediu para parar.
      store.fail(job.id, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Resposta de "Sugerir cortes", lida dos arquivos que a triagem grava.
   * O proxy é gerado aqui dentro: só uma triagem por vez chega nele.
   */
  async function triageReply(): Promise<Record<string, unknown>> {
    const stored = await loadStored();
    const suggested = await runTriage(pipelineJob, exec, provider, opts.triageFn, {
      env: visualEnv, fetchImpl: opts.fetchImpl, credentialsDir: visualDir, stored,
    });
    const report = await readFile(join(workDir, "out", "triage.md"), "utf8")
      .catch(() => "");
    // Preferir campos estruturados (drop / reviewFlags) em vez de
    // parsear o markdown — o relatório muda de forma, a prévia não.
    let drop: unknown[] | undefined;
    let reviewFlags: unknown[] | undefined;
    let stats: ReturnType<typeof editorialStats> | undefined;
    try {
      const json = await readJson(join(workDir, "out", "triage.json")) as {
        drop?: { unit_ids: string[]; reason: string }[];
        reviewFlags?: unknown[];
      };
      drop = json.drop;
      reviewFlags = json.reviewFlags;
      // Telemetria editorial: drop × índice dá os segundos e o motivo
      // dominante. Falha aqui não tira a prévia — stats fica indefinido.
      const index = await readJson(indexPath(pipelineJob)) as {
        units?: { id: string; start: number; end: number }[];
      };
      // Índice cru pode trazer unidade sem tempo numérico; sem o filtro,
      // ela vira "corta NaNmNaNs" no resumo da prévia.
      const units = (index.units ?? []).filter((u) =>
        typeof u.start === "number" && typeof u.end === "number"
        && Number.isFinite(u.start) && Number.isFinite(u.end)
      );
      stats = editorialStats(units, json.drop ?? []);
    } catch {
      // triage.json é novo; fallback no markdown — e a leitura do índice
      // ou do próprio stats falhando também cai aqui, sem stats.
    }
    return {
      keepList: suggested,
      motivos: motivosFromReport(report),
      drop,
      reviewFlags,
      stats,
      report,
    };
  }

  /**
   * O que decide se dois pedidos de triagem dão a mesma resposta: a fonte, o
   * índice, o provedor resolvido e o passe (só estrutura, sem orçamento, no
   * app). São as entradas da chave de cache que o servidor enxerga.
   */
  async function triageRequestKey(): Promise<string> {
    const source = await stat(input).catch(() => null);
    const index = await stat(indexPath(pipelineJob)).catch(() => null);
    let providerId: string;
    try {
      providerId = (await triageIdentity({ provider, projectDir: process.cwd(), credentialsDir: visualDir, env: visualEnv })).providerId;
    } catch (error) {
      providerId = `sem provedor: ${error instanceof Error ? error.message : String(error)}`;
    }
    return JSON.stringify({
      source: source ? [input, source.size, source.mtimeMs] : null,
      index: index ? [index.size, index.mtimeMs] : null,
      providerId,
      pass: "structure",
      budgetSeconds: null,
    });
  }

  // Fila de um para a triagem paga: duas abas ou um reload não disparam duas
  // chamadas, e a segunda nunca lê o proxy ainda em escrita. Pedido
  // equivalente espera a que está em voo e recebe a mesma resposta.
  let triageFlight: { key: string; reply: Promise<Record<string, unknown>> } | null = null;

  let initialIngestStarted = false;
  let boundPort = opts.port ?? 7788;
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (!guardLocalRequest(req, res, boundPort)) return;
      // Dentro do handle: `GET //` faz o `new URL` estourar, e fora do catch
      // isso derrubava o processo inteiro.
      const url = parseRequestUrl(req.url);
      if (!url) { sendJson(res, { error: "URL inválida" }, 400); return; }
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }

      if (await providerVisual(req, res, { dir: visualDir, env: visualEnv, loadStored, invalidateStored: readStored.invalidate, includeAssemblyTextNotice: false, onJevDisabled: () => {
        // A revogação vale mesmo se decision.json não puder ser relido.
        cleanup.cancelNotes(); return cleanup.refreshNotes();
      } })) return;
      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir, readStored)) return;
      if (opts.autoStart !== false && !initialIngestStarted) {
        initialIngestStarted = true;
        void ingest();
      }

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(withVisualNotice(page.replace("window.__JOB__", JSON.stringify(job.id)), keyProviderState(visualEnv, await loadStored(), false).notice));
        return;
      }

      if (["/keeplist.js", "/fillers-ui.js", "/review-generation.js"].includes(url.pathname)) {
        // O mesmo arquivo que o teste importa. Servir verbatim é o que garante
        // que a página e o servidor concordam sobre o que é uma faixa.
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(await readFile(join(HERE, basename(url.pathname)), "utf8"));
        return;
      }

      if (url.pathname === "/media/audio") {
        if (!audioReady) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("proxy de áudio ainda não existe");
          return;
        }
        await serveMedia(req, res, audioProxyPath(pipelineJob), "audio/mp4");
        return;
      }

      if (url.pathname === "/media") {
        try {
          await serveMedia(req, res, input);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("mídia não encontrada");
            return;
          }
          throw error;
        }
        return;
      }

      if (parts[0] === "jobs" && parts[1]) {
        let current = store.get(parts[1]);
        if (!current) { sendJson(res, { error: "job não existe" }, 404); return; }

        if (parts.length === 2 && req.method === "GET") {
          await cleanup.refreshNotes();
          current = store.get(parts[1])!;
          sendJson(res, {
            stage: current.stage, error: current.error, warning: [current.warning, current.fillerWarning].filter(Boolean).join("; ") || undefined,
            fillerWarning: current.fillerWarning, fillerNotesPending: current.fillerNotesPending ?? false, planning: cleanup.planning(),
            progress: current.progress,
            keepList: current.keepList, review: current.review,
            generation: current.review?.generation ?? 0, desiredGeneration: cleanup.generation(), fillerNotes: current.fillerNotes,
            source: basename(input),
            audio: audioReady,
          });
          return;
        }

        if (parts[2] === "cancel" && req.method === "POST") {
          store.cancel(current.id);
          // Trocar o enum não para o WhisperX. Sem matar o processo, quem
          // cancelou espera do mesmo jeito — que é o motivo de cancel existir.
          ingestAbort.abort();
          if (exec instanceof SpawnExecutor) exec.killAll();
          sendJson(res, { ok: true });
          return;
        }

        if (parts[2] === "keep" && req.method === "POST") {
          const body = await readBody(req);
          // A borda aceita um formato só: a mesma string que o --keep consome.
          if (typeof body.keepList !== "string") {
            sendJson(res, { error: "keepList precisa ser string, no formato \"u001-u003 u005\"" }, 400);
            return;
          }
          const invalid = keepListError(body.keepList);
          if (invalid) { sendJson(res, { error: invalid }, 400); return; }
          await replan(body.keepList);
          sendJson(res, { review: store.get(current.id)!.review });
          return;
        }

        if (parts[2] === "fillers" && req.method === "POST") {
          const body = await readBody(req);
          try { await cleanup.fillers(body); }
          catch (error) {
            if (error instanceof FillerRequestError) { sendJson(res, { error: error.message }, error.status); return; }
            throw error;
          }
          sendJson(res, { review: store.get(current.id)!.review });
          return;
        }

        if (parts[2] === "triage" && req.method === "POST") {
          // O proxy de triagem sai da fonte: vídeo trocado com o app aberto
          // misturaria a transcrição antiga com a imagem nova.
          const mismatch = await sourceMismatch(workDir, input);
          if (mismatch) { sendJson(res, { error: mismatch }, 409); return; }
          const key = await triageRequestKey();
          if (triageFlight && triageFlight.key !== key) {
            sendJson(res, {
              error: "já há uma triagem em andamento com outros parâmetros (fonte, índice ou provedor). " +
                "Espere ela terminar e peça de novo.",
            }, 409);
            return;
          }
          if (!triageFlight) {
            const flight = { key, reply: triageReply() };
            triageFlight = flight;
            void flight.reply.finally(() => {
              if (triageFlight === flight) triageFlight = null;
            }).catch(() => {});
          }
          sendJson(res, await triageFlight.reply);
          return;
        }

        if (parts[2] === "export" && req.method === "POST") {
          const body = await readBody(req);
          const kind = String(body.kind ?? "");
          // Todo export sai do plano da fonte transcrita: com o vídeo trocado,
          // EDL e MP4 apontariam cortes do antigo para a mídia nova.
          const mismatch = await sourceMismatch(workDir, input);
          if (mismatch) { sendJson(res, { error: mismatch }, 409); return; }
          if (typeof body.keepList === "string") {
            const invalid = keepListError(body.keepList);
            if (invalid) { sendJson(res, { error: invalid }, 400); return; }
          }
          // Export sempre re-planeja: nenhum arquivo sai de um plano velho.
          if (typeof body.keepList === "string") await replan(body.keepList);
          const plan = await readJson(planPath(pipelineJob)) as Record<string, any>;

          if (kind === "edl") {
            // Do arquivo, nunca assumido: suporta frame rate inteiro ou 29,97 drop-frame.
            const fps = await probeFps(pipelineJob, exec, { allowDropFrame: true });
            // In-points a partir do timecode embutido, como no OTIO da montagem.
            const startSeconds = await probeSourceStartSeconds(pipelineJob, exec);
            const out = join(workDir, "corte.edl");
            await writeFile(out, buildEdl({
              clips: plan.clips, fps, title: basename(input),
              sourceStartFrames: Math.round(startSeconds * fps),
            }), "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/edl` });
            return;
          }
          if (kind === "otio") {
            const info = await probe(input);
            const rate = info.frameRate;
            if (!rate) {
              throw new Error("fonte sem frame rate para exportar OTIO");
            }
            const fps = rate.num / rate.den;
            const durationSeconds = Math.max(info.durationMs / 1000, 0.001);
            const clips = plan.clips as { start: number; end: number }[];
            const videoClips = otioClipsForPlan(clips, fps, durationSeconds);
            const width = info.width;
            const height = info.height;
            if (!width || !height || width % 2 !== 0 || height % 2 !== 0) {
              throw new Error("fonte com canvas inválido para exportar OTIO");
            }
            const sha256 = await hashFile(input);
            const audioClips = videoClips.map((clip, i) => ({ ...clip, id: `a_c${i + 1}` }));
            const assembly: Assembly = {
              version: 1,
              revision: 1,
              name: basename(input),
              fps: rate,
              width,
              height,
              sources: [{
                id: "src1",
                path: resolve(input),
                sha256,
                durationSeconds,
                hasVideo: info.hasVideo,
                hasAudio: info.hasAudio,
                fps: rate,
                width,
                height,
                // O mesmo parse da montagem: o OTIO soma o início da mídia aos
                // in-points e recusa etiqueta ilegível.
                timecode: info.timecode ? parseSourceTimecode(info.timecode, rate) : null,
                role: "speech",
                included: true,
                name: basename(input),
              }],
              tracks: [
                { kind: "Video", name: "V1", clips: info.hasVideo ? videoClips : [] },
                { kind: "Video", name: "V2", clips: [] },
                { kind: "Audio", name: "A1", clips: info.hasAudio ? audioClips : [] },
              ],
            };
            const out = join(workDir, "corte.otio");
            await writeFile(out, `${buildOtio(assembly)}\n`, "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/otio` });
            return;
          }
          if (kind === "mp4") {
            const out = join(workDir, "corte.mp4");
            await runRender(pipelineJob, out, exec);
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/mp4` });
            return;
          }
          if (kind === "srt") {
            // Legendas do corte: palavras do WhisperX (cache do workDir, sem
            // etapa nova de minutos) + clipes do plano, remarcadas na saída.
            // O transcript em disco é o formato do motor — segments[].words[]
            // com tempo em SEGUNDOS (ver condense/prepare.ts) — não o
            // `tokens[]` em ms do tipo interno Transcript.
            const transcript = await readJson(transcriptPath(pipelineJob)) as {
              segments?: { words?: { text?: unknown; start?: unknown; end?: unknown }[] }[];
            };
            // Palavra sem texto ou com tempo inválido entra fora; converter
            // tudo para ms arredondado é o que o builder consome.
            const words = (transcript.segments ?? [])
              .flatMap((s) => s.words ?? [])
              .flatMap((w): SrtWord[] => {
                if (
                  typeof w.text !== "string"
                  || typeof w.start !== "number" || !Number.isFinite(w.start)
                  || typeof w.end !== "number" || !Number.isFinite(w.end)
                ) return [];
                return [{ text: w.text, startMs: Math.round(w.start * 1_000), endMs: Math.round(w.end * 1_000) }];
              });
            const out = join(workDir, "corte.srt");
            await writeFile(out, buildSrt({ clips: plan.clips, words }), "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/srt` });
            return;
          }
          if (kind === "transcript") {
            sendJson(res, {
              path: join(workDir, "out", "condensed_transcript.json"),
              downloadUrl: `/jobs/${current.id}/download/transcript`,
            });
            return;
          }
          sendJson(res, { error: `kind desconhecido: ${kind}` }, 400);
          return;
        }

        if (parts[2] === "download" && parts[3]) {
          const files: Record<string, string> = {
            edl: join(workDir, "corte.edl"),
            otio: join(workDir, "corte.otio"),
            mp4: join(workDir, "corte.mp4"),
            srt: join(workDir, "corte.srt"),
            transcript: join(workDir, "out", "condensed_transcript.json"),
          };
          const path = files[parts[3]];
          if (!path) { sendJson(res, { error: "arquivo desconhecido" }, 404); return; }
          // Stream, não readFile: o MP4 de um talking-head de 4 minutos já
          // passa de 300 MB, e carregá-lo inteiro na RAM para servir derruba o
          // processo justamente no caminho secundário.
          const { size } = await stat(path);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${basename(path)}"`,
            "content-length": size,
          });
          await pipeline(createReadStream(path), res);
          return;
        }
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("não encontrado");
    };

    handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, { error: message }, error instanceof BodyTooLargeError ? 413 : 500);
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? 7788, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);
  boundPort = port;

  if (opts.autoStart !== false && !opts.providerConfigDir) {
    initialIngestStarted = true;
    void ingest();
  }

  return {
    port, address: "127.0.0.1", jobId: job.id,
    close: async () => {
      // Tudo é iniciado antes do primeiro await: no `exit` só o trecho
      // síncrono roda, e é nele que os filhos recebem o sinal.
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      store.cancel(job.id);
      const notesClosed = cleanup.close();
      const speechClosed = closeSpeech();
      const closed = new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.all([killed, speechClosed, closed, notesClosed]);
    },
    killChildren: () => { if (exec instanceof SpawnExecutor) exec.killNow(); },
  };
}

/**
 * Página da montagem com a pasta do projeto na meta `decupa-project-dir`
 * (o menu do projeto a mostra). O caminho entra escapado para atributo HTML.
 */
export function withProjectDir(page: string, dir: string): string {
  const escaped = dir.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  // Substituição por função: uma pasta com `$&`, `$$` ou `$\`` não é padrão de replace.
  return page.replace('<meta name="decupa-project-dir" content="">',
    () => `<meta name="decupa-project-dir" content="${escaped}">`);
}

async function startAssemblyApp(opts: {
  projectDir: string;
  inputs?: string[];
  port?: number;
  providerConfigDir?: string;
  templatesRoot?: string;
  executor?: Executor;
  selectFn?: AssemblyDeps["selectFn"];
  proposeSend?: AssemblyDeps["proposeSend"];
  describeClient?: AssemblyDeps["describeClient"];
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  speech?: IngestSpeech;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  decisionLog?: (line: string) => void;
}): Promise<AppHandle> {
  if (opts.providerConfigDir) {
    await installCompanyCredentials(opts.providerConfigDir, opts.env ?? process.env);
  }
  const dir = resolve(opts.projectDir);
  const visualEnv = { ...(opts.env ?? process.env) };
  const visualDir = opts.providerConfigDir ?? homedir();
  const readStored = createCredentialsReader();
  const loadStored = () => readAnalysisCredentials(dir, visualDir, readStored);
  const stored = await loadStored();
  const transports = resolveAppTransports({ ...opts, stored, loadStored });
  const resolveOperationDeps = operationResolver({ dir, loadStored, env: visualEnv, fetchImpl: opts.fetchImpl,
    describeClient: opts.describeClient, enableVisual: Boolean(opts.describeClient || opts.allowPaidVisual || opts.providerConfigDir),
    proposeSend: opts.proposeSend, enableText: Boolean(opts.proposeSend || opts.allowPaidModel || opts.providerConfigDir) });
  const { decision } = await resolveOperationDeps();
  opts.decisionLog?.(`provider=typesafe model=${decision.model} elapsedMs=0 fallback=${decision.mode === "off" ? "off" : "not-run"}`);
  const exec = opts.executor ?? new SpawnExecutor();
  const { speech, closeSpeech } = attachResidentSpeech({
    dir,
    speech: opts.speech,
    executorInjected: Boolean(opts.executor),
  });
  const page = await readFile(join(HERE, "assembly", "page.html"), "utf8");
  const pageCss = await readFile(join(HERE, "assembly", "page.css"), "utf8");
  const pageJs = await readFile(join(HERE, "assembly", "page.js"), "utf8");
  let boundPort = opts.port ?? 7788;
  const allowPaidModel = opts.allowPaidModel === true;
  const allowPaidVisual = opts.allowPaidVisual === true;
  const templatesRoot=opts.templatesRoot??join(opts.providerConfigDir??homedir(),".decupa","templates");
  const templates=createTemplateRuntime(templatesRoot,{
    port:()=>boundPort,selectFn:opts.selectFn,exec,speech,
    send:transports.textSend,visualClient:transports.visualClient,
    modelKey:transports.textKey,legacyModelKey:transports.legacyModelKey,legacyVisualCompatible:transports.legacyVisualCompatible,
    resolveAnalysis:transports.resolveAnalysis,
    allowModel:allowPaidModel,allowVisual:allowPaidVisual,
  });
  const runtime = createAssemblyRuntime(dir, {
    templatesRoot,
    decision,
    exec,
    port: () => boundPort,
    selectFn: opts.selectFn,
    allowPaidModel,
    allowPaidVisual,
    proposeSend: opts.proposeSend ?? ((allowPaidModel || opts.providerConfigDir) ? transports.textSend : undefined),
    describeClient: opts.describeClient ?? ((allowPaidVisual || opts.providerConfigDir) ? transports.visualClient : undefined),
    resolveOperationDeps,
    fillerFetchImpl: opts.fetchImpl,
    speech,
  });
  const project = await runtime.ensureProject(opts.inputs);
  const newProjects: AppHandle[] = [];

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (!guardLocalRequest(req, res, boundPort)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
      if (await providerVisual(req, res, { dir: visualDir, env: visualEnv, loadStored, invalidateStored: readStored.invalidate, onJevDisabled: () => cancelAssemblyFillerNotes(dir) })) return;
      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir, readStored)) return;
      if (url.pathname === "/project/new" && req.method === "POST") {
        const nextDir = await mkdtemp(join(dirname(dir), "projeto-"));
        const next = await startAssemblyApp({
          ...opts, projectDir: nextDir, inputs: undefined, port: 0,
        });
        newProjects.push(next);
        const nextUrl = `http://127.0.0.1:${next.port}/`;
        // A pasta nova precisa ser achável depois: vai no log e na resposta.
        console.log(`novo projeto em ${nextDir}: ${nextUrl}`);
        sendJson(res, { url: nextUrl, dir: nextDir }, 201);
        return;
      }


      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(withVisualNotice(withProjectDir(page, dir), keyProviderState(visualEnv, await loadStored()).notice));
        return;
      }
      if (url.pathname === "/page.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        res.end(pageCss);
        return;
      }
      if (url.pathname === "/page.js") {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        res.end(pageJs);
        return;
      }
      if(await templates.handleTemplates(req,res))return;
      const handled = await runtime.handleAssembly(req, res, dir);
      if (handled) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("não encontrado");
    };
    handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, { error: message }, 500);
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? 7788, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);
  boundPort = port;

  return {
    port, address: "127.0.0.1", jobId: project.id,
    close: async () => {
      // Tudo é iniciado antes do primeiro await: no `exit` só o trecho
      // síncrono roda, e é nele que os filhos e o worker de fala morrem.
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      const speechClosed = closeSpeech();
      const nested = Promise.all(newProjects.map(app => app.close()));
      const closed = new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.all([killed, speechClosed, nested, closed]);
    },
    killChildren: () => {
      if (exec instanceof SpawnExecutor) exec.killNow();
      for (const app of newProjects) app.killChildren();
    },
  };
}
