import { createFileCoordinator } from "@decupa/coordinator";
import { hashFile, probe } from "@decupa/media";
import { collectSink, createTracer } from "@decupa/trace";
import { createResidentSpeechClient } from "@decupa/transcript";
import { providerSetup } from "./provider-setup.ts";
import { createReadStream } from "node:fs";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { serveMedia } from "../http/media.ts";
import { originAllowed } from "../http/origin.ts";
import { buildEdl } from "./edl.ts";
import { buildOtio } from "./assembly/otio.ts";
import type { Assembly } from "./assembly/types.ts";
import { JobStore } from "./jobs.ts";
import {
  indexPath, planPath, preflight, probeFps, runIngest, runPlan, runRender, runTriage,
  SpawnExecutor, transcriptPath, visualIndexPath, type Executor, type IngestSpeech, type PipelineJob,
} from "./pipeline.ts";
import { buildReview, type ReviewUnitFlag } from "./review.ts";
import { buildSrt, type SrtWord } from "./srt.ts";
import { editorialStats } from "./stats.ts";
import { initialKeepList, readKeepList, writeKeepList } from "./session.ts";
import { createAssemblyRuntime, type AssemblyDeps } from "./assembly/routes.ts";

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

async function readBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
}

function attachResidentSpeech(opts: {
  dir: string;
  speech?: IngestSpeech;
  executorInjected: boolean;
}): { speech?: IngestSpeech; closeSpeech: () => Promise<void> } {
  if (opts.speech) return { speech: opts.speech, closeSpeech: async () => undefined };
  if (opts.executorInjected) return { closeSpeech: async () => undefined };
  const client = createResidentSpeechClient();
  const coordinator = createFileCoordinator(join(opts.dir, ".decupa", "coordinator"), { limit: 1 });
  return {
    speech: { worker: (req) => client.transcribe(req), coordinator },
    closeSpeech: () => client.close(),
  };
}

export async function startApp(opts: {
  input?: string;
  projectDir?: string;
  inputs?: string[];
  port?: number;
  providerConfigDir?: string;
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
  }) => Promise<{ keepList: string }>;
  selectFn?: AssemblyDeps["selectFn"];
  proposeSend?: (content: unknown[], signal?: AbortSignal) => Promise<string>;
  describeClient?: { send(content: unknown[], signal?: AbortSignal): Promise<string> };
  /** Autorização explícita; desligada por padrão. Não dispara chamada sozinha. */
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  /** Worker residente injetável; em produção o serviço cria um `worker.py --serve`. */
  speech?: IngestSpeech;
}): Promise<AppHandle> {
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
  provider?: string;
  executor?: Executor;
  autoStart?: boolean;
  workDir?: string;
  speech?: IngestSpeech;
  triageFn?: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
  }) => Promise<{ keepList: string }>;
}): Promise<AppHandle> {
  const input = resolve(opts.input);
  const exec = opts.executor ?? new SpawnExecutor();
  const provider = opts.provider;
  const page = await readFile(join(HERE, "page.html"), "utf8");

  const workDir = opts.workDir
    ?? join(dirname(input), `.decupa-${basename(input).replace(/\.[^.]+$/, "")}`);
  await mkdir(join(workDir, "out"), { recursive: true });
  const { speech, closeSpeech } = attachResidentSpeech({
    dir: workDir,
    speech: opts.speech,
    executorInjected: Boolean(opts.executor),
  });
  const ingestAbort = new AbortController();

  const store = new JobStore();
  const job = store.create({ videoPath: input, workDir });
  const pipelineJob: PipelineJob = { id: job.id, videoPath: input, workDir };
  const traces = collectSink();
  const tracer = createTracer(traces);

  // Fila de um: `condense_plan` grava sempre no mesmo condense_plan.json, e o
  // debounce de 250 ms não impede que um segundo re-plano comece com o
  // primeiro ainda rodando. Dois processos escrevendo o mesmo arquivo fazem o
  // último a gravar vencer — e o review devolvido pode ser o do keep-list
  // antigo, que é exatamente o aviso mentiroso que o debounce existia para
  // evitar.
  let planning: Promise<void> = Promise.resolve();
  let pendingKeepList: string | null = null;

  async function replan(keepList: string): Promise<void> {
    pendingKeepList = keepList;
    const mine = planning.then(async () => {
      // Se outro pedido chegou enquanto este esperava, aquele é o atual:
      // rodar este seria gastar processo para produzir um plano obsoleto.
      if (pendingKeepList !== keepList) return;
      try {
        store.setStage(job.id, "planning");
        await runPlan(pipelineJob, keepList, exec, tracer);
        const review = buildReview(
          await readJson(planPath(pipelineJob)),
          await readJson(indexPath(pipelineJob)),
          await maybeVisual(pipelineJob),
          await maybeInspectFlags(workDir),
        );
        store.setReview(job.id, review, keepList);
        // Falhar aqui não pode derrubar o corte que já está na tela: o review
        // é o produto, a sessão em disco é conveniência. Mas também não some
        // em silêncio — vai pelo mesmo canal de aviso que o ingest usa.
        await writeKeepList(workDir, keepList).catch(() => {
          store.setWarning(job.id, "não consegui gravar keep.txt; esta sessão não será retomada");
        });
      } catch (error) {
        // GET /jobs/:id é o poll da página. Sem review ainda (primeiro plano
        // do ingest), fail é o certo. Com review, error é irreversível e o
        // poll nunca voltaria a pintar o corte — volta a ready. O POST
        // ainda estoura 500 com a mensagem do motor.
        const current = store.get(job.id);
        if (current?.review) store.setStage(job.id, "ready");
        else store.fail(job.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    planning = mine.catch(() => {});
    await mine;
    // Keep supersedido não pode responder antes do vencedor gravar o review:
    // a página faz `if (r.review) { review = r.review; render(); }` e um
    // `{review: undefined}` rebobinaria a tela para o corte antigo.
    if (pendingKeepList !== keepList) await planning;
  }

  async function ingest(): Promise<void> {
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
      );
      if (ingestResult.warning) store.setWarning(job.id, ingestResult.warning);
      if (store.get(job.id)?.stage === "cancelled") return;
      const index = await readJson(indexPath(pipelineJob)) as { units: { id: string }[] };
      const saved = await readKeepList(workDir);
      await replan(initialKeepList(saved, index.units.map((u) => u.id)));
    } catch (error) {
      // `fail` não sobrescreve `cancelled`: matar o processo faz a etapa
      // falhar, e esse erro não é notícia para quem pediu para parar.
      store.fail(job.id, error instanceof Error ? error.message : String(error));
    }
  }

  let initialIngestStarted = false;
  let boundPort = opts.port ?? 7788;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    const handle = async (): Promise<void> => {
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }

      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir)) return;
      if (opts.autoStart !== false && !initialIngestStarted) {
        initialIngestStarted = true;
        void ingest();
      }

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page.replace("window.__JOB__", JSON.stringify(job.id)));
        return;
      }

      if (url.pathname === "/keeplist.js") {
        // O mesmo arquivo que o teste importa. Servir verbatim é o que garante
        // que a página e o servidor concordam sobre o que é uma faixa.
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(await readFile(join(HERE, "keeplist.js"), "utf8"));
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
        const current = store.get(parts[1]);
        if (!current) { sendJson(res, { error: "job não existe" }, 404); return; }

        if (parts.length === 2 && req.method === "GET") {
          sendJson(res, {
            stage: current.stage, error: current.error, warning: current.warning,
            progress: current.progress,
            keepList: current.keepList, review: current.review,
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
          await replan(body.keepList);
          sendJson(res, { review: store.get(current.id)!.review });
          return;
        }

        if (parts[2] === "triage" && req.method === "POST") {
          const suggested = await runTriage(pipelineJob, exec, provider, opts.triageFn);
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
          sendJson(res, {
            keepList: suggested,
            motivos: motivosFromReport(report),
            drop,
            reviewFlags,
            stats,
            report,
          });
          return;
        }

        if (parts[2] === "export" && req.method === "POST") {
          const body = await readBody(req);
          const kind = String(body.kind ?? "");
          // Export sempre re-planeja: nenhum arquivo sai de um plano velho.
          if (typeof body.keepList === "string") await replan(body.keepList);
          const plan = await readJson(planPath(pipelineJob)) as Record<string, any>;

          if (kind === "edl") {
            // Do arquivo, nunca assumido: suporta frame rate inteiro ou 29,97 drop-frame.
            const fps = await probeFps(pipelineJob, exec, { allowDropFrame: true });
            const out = join(workDir, "corte.edl");
            await writeFile(out, buildEdl({
              clips: plan.clips, fps, title: basename(input),
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

  if (opts.autoStart !== false && !opts.providerConfigDir) {
    initialIngestStarted = true;
    void ingest();
  }

  return {
    port, address: "127.0.0.1", jobId: job.id,
    close: async () => {
      if (exec instanceof SpawnExecutor) exec.killAll();
      await closeSpeech();
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}

function lazyPaidSend(projectDir: string, configDir?: string): (content: unknown[], signal?: AbortSignal) => Promise<string> {
  let client: { send(content: unknown[], signal?: AbortSignal): Promise<string> } | undefined;
  return async (content, signal) => {
    if (!client) {
      const { createAnalysisClient, readCredentials } = await import("@decupa/triage");
      const stored = await readCredentials(projectDir).catch(() => null)
        ?? (configDir ? await readCredentials(configDir).catch(() => null) : null);
      client = createAnalysisClient({ stored });
    }
    return client.send(content, signal);
  };
}

async function startAssemblyApp(opts: {
  projectDir: string;
  inputs?: string[];
  port?: number;
  providerConfigDir?: string;
  executor?: Executor;
  selectFn?: AssemblyDeps["selectFn"];
  proposeSend?: AssemblyDeps["proposeSend"];
  describeClient?: AssemblyDeps["describeClient"];
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  speech?: IngestSpeech;
}): Promise<AppHandle> {
  const dir = resolve(opts.projectDir);
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
  const runtime = createAssemblyRuntime(dir, {
    exec,
    port: () => boundPort,
    selectFn: opts.selectFn,
    allowPaidModel,
    allowPaidVisual,
    proposeSend: opts.proposeSend ?? ((allowPaidModel || opts.providerConfigDir) ? lazyPaidSend(dir, opts.providerConfigDir) : undefined),
    describeClient: opts.describeClient ?? ((allowPaidVisual || opts.providerConfigDir) ? { send: lazyPaidSend(dir, opts.providerConfigDir) } : undefined),
    speech,
  });
  const project = await runtime.ensureProject(opts.inputs);

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir)) return;

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
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
      if (exec instanceof SpawnExecutor) exec.killAll();
      await closeSpeech();
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}
