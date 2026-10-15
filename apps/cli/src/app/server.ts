import { createTemplateRuntime } from "./templates/routes.ts";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createFileCoordinator } from "@decupa/coordinator";
import { hashFile, probe } from "@decupa/media";
import { createTracer } from "@decupa/trace";
import { createResidentSpeechClient } from "@decupa/transcript";
import { createCredentialsReader, installCompanyCredentials, readAnalysisCredentials, resolveAssemblyTextProvider, resolveVisualProvider, analysisClientOptions, assemblyTextClientOptions } from "@decupa/triage";
import { resolveAppTransports } from "./analysis-transports.ts";
import { providerSetup } from "./provider-setup.ts";
import { keyProviderState, providerVisual, withVisualNotice } from "./provider-visual.ts";
import { operationResolver } from "./analysis-operation.ts";
import { cancelAssemblyFillerNotes } from "./assembly/filler-observe.ts";
import { access, readFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeBind, guardLocalRequest, hostConfig, isLoopbackBind, originAllowed, resolveHostConfig } from "../http/origin.ts";
import type { Assembly } from "./assembly/types.ts";
import { JobStore } from "./jobs.ts";
import { createCleanupPlanning } from "../condense/cleanup-planning.ts";
import {
  assertSidecarSynced, ensureAudioProxy, indexPath, preflight, runIngest, runTriage, SPEECH_SCRIPT, SpawnExecutor,
  visualIndexPath, type Executor, type IngestSpeech, type PipelineJob,
} from "./pipeline.ts";
import { triageIdentity } from "../triage.ts";
import type { ReviewUnitFlag } from "./review.ts";
import { editorialStats } from "./stats.ts";
import { claimWorkDir, cleanupWorkDir, readSourceManifest } from "./session.ts";
import { blankProject, createAssemblyRuntime, type AssemblyDeps } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import type { VisualClient } from "./assembly/model.ts";
import { BodyTooLargeError, createCleanupRuntime } from "./cleanup/routes.ts";
import { createHeavyCoordinator } from "./heavy-work.ts";
import { createMediaRuntime, type MediaRuntime } from "./media-runtime.ts";
import { projectUrl } from "./project-url.ts";
import { createProjectRuntimeRegistry, PROJECT_ID_PATTERN } from "./project-root.ts";
import { createAuthRuntime } from "./auth.ts";

export { projectUrl };
export { MAX_BODY_BYTES } from "./cleanup/routes.ts";

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

async function createAssemblyInProjectsRoot(projectsRoot: string): Promise<{ id: string; dir: string; url: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `projeto-${randomUUID().replace(/-/g, "").slice(0, 4)}`;
    const dir = join(projectsRoot, id);
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await createProject(dir, blankProject(randomUUID()));
    return { id, dir, url: `/projects/${id}/` };
  }
  throw new Error("não foi possível reservar uma pasta para o novo Projeto");
}

function parseRequestUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

async function configuredMediaRuntime(
  env: Record<string, string | undefined> | undefined,
  now?: () => number,
): Promise<MediaRuntime | undefined> {
  // Sem raiz configurada, o app legado continua sem criar diretório implícito
  // nem gravar Mídias na máquina de quem usa apenas a Limpeza local.
  const source = env ?? process.env;
  const root = source.DECUPA_MEDIA_ROOT;
  if (!root) return undefined;
  return createMediaRuntime({ root, env: source, now });
}

/** Os corpos da limpeza são um keep-list e um `kind`: 1 MiB sobra. Sem teto,
 *  um POST gigante enche a memória do processo que segura os jobs. */
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
  const memoCoordinator = () => createFileCoordinator(join(opts.dir, ".decupa", "coordinator"));
  if (opts.speech) {
    if (opts.speech.coordinator) {
      return { speech: opts.speech, closeSpeech: async () => undefined };
    }
    return { speech: { ...opts.speech, coordinator: memoCoordinator() }, closeSpeech: async () => undefined };
  }
  if (opts.executorInjected) return { closeSpeech: async () => undefined };
  const client = createResidentSpeechClient();
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
    speech: {
      worker: async (req) => { await ensureSynced(); return client.transcribe(req); },
      coordinator: memoCoordinator(),
    },
    closeSpeech: () => client.close(),
  };
}

type StartAppOptions = {
  input?: string;
  projectDir?: string;
  projectsRoot?: string;
  projectId?: string;
  inputs?: string[];
  port?: number;
  providerConfigDir?: string;
  /** Diretório compartilhado do coordinator; injetado nos testes. */
  coordinatorDir?: string;
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
  /** Relógio do acervo; nos testes permite envelhecer envios sem esperar. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  decisionLog?: (line: string) => void;
};

export async function startApp(opts: StartAppOptions): Promise<AppHandle> {
  resolveVisualProvider(opts.env ?? process.env);
  if (opts.projectsRoot) {
    const projectId = opts.projectId ?? (opts.projectDir ? basename(resolve(opts.projectDir)) : undefined);
    return startProjectRootApp({ ...opts, projectId } as StartAppOptions & { projectsRoot: string });
  }
  if (opts.projectDir && !opts.input) {
    return startAssemblyApp(opts as typeof opts & { projectDir: string });
  }
  if (!opts.input) throw new Error("startApp precisa de input ou projectDir");
  return startCleanupApp({ ...opts, input: opts.input });
}

async function startProjectRootApp(opts: StartAppOptions & { projectsRoot: string }): Promise<AppHandle> {
  const env = opts.env ?? process.env;
  const network = resolveHostConfig(hostConfig(env));
  // Mesmo portão dos modos legados: este é o modo que a CLI usa, então
  // escutar fora do loopback sem senha não sobe.
  assertSafeBind(network, Boolean(env.DECUPA_AUTH_PASSWORD));
  const auth = await createAuthRuntime({ env, configDir: opts.providerConfigDir, network, now: opts.now });
  const media = await configuredMediaRuntime(opts.env, opts.now);
  const teamMode = auth.enabled || !isLoopbackBind(network.bindHost);
  if (opts.providerConfigDir) {
    await installCompanyCredentials(opts.providerConfigDir, opts.env ?? process.env);
  }
  const projectsRoot = resolve(opts.projectsRoot);
  await mkdir(projectsRoot, { recursive: true });
  if (opts.projectId) {
    if (!PROJECT_ID_PATTERN.test(opts.projectId)) throw new Error("id de Projeto inválido");
    const initialDir = resolve(opts.projectDir ?? resolve(projectsRoot, opts.projectId));
    if (dirname(initialDir) !== projectsRoot || basename(initialDir) !== opts.projectId) throw new Error("Projeto inicial fora da Raiz");
    if (opts.input) {
      await mkdir(initialDir, { recursive: true });
      await claimWorkDir(initialDir, resolve(opts.input), opts.now, {
        flow: "limpeza", displayName: basename(resolve(opts.input)),
      });
    } else {
      await mkdir(initialDir, { recursive: true });
      try {
        await access(join(initialDir, "project.json"));
      } catch {
        await createProject(initialDir, blankProject(randomUUID()));
      }
    }
  }
  const visualEnv = { ...(opts.env ?? process.env) };
  const coordinator = opts.coordinatorDir || opts.providerConfigDir
    ? createHeavyCoordinator({ coordinatorDir: opts.coordinatorDir, configDir: opts.providerConfigDir, env: visualEnv })
    : undefined;
  const exec = opts.executor ?? new SpawnExecutor();
  const visualDir = opts.providerConfigDir ?? homedir();
  const readStored = createCredentialsReader();
  const globalLoadStored = () => readAnalysisCredentials(projectsRoot, visualDir, readStored);
  const globalStored = await globalLoadStored();
  const globalTransports = resolveAppTransports({ ...opts, stored: globalStored, loadStored: globalLoadStored });
  const { page, projectPathJs, pageCss, pageJs } = await loadAssemblyPageAssets();
  const cleanupPage = await readFile(join(HERE, "page.html"), "utf8");
  let boundPort = opts.port ?? 7788;
  const allowPaidModel = opts.allowPaidModel === true;
  const allowPaidVisual = opts.allowPaidVisual === true;
  const templatesRoot = opts.templatesRoot ?? join(opts.providerConfigDir ?? homedir(), ".decupa", "templates");
  const templates = createTemplateRuntime(templatesRoot, {
    port: () => boundPort,
    selectFn: opts.selectFn,
    exec,
    speech: opts.speech,
    send: globalTransports.textSend,
    visualClient: globalTransports.visualClient,
    modelKey: globalTransports.textKey,
    legacyModelKey: globalTransports.legacyModelKey,
    legacyVisualCompatible: globalTransports.legacyVisualCompatible,
    resolveAnalysis: globalTransports.resolveAnalysis,
    allowModel: allowPaidModel,
    allowVisual: allowPaidVisual,
  });

  const registry = createProjectRuntimeRegistry({
    projectsRoot,
    createRuntime: async ({ id, dir, prefix, kind }) => {
      if (kind === "cleanup") {
        const manifest = await readSourceManifest(dir);
        if (!manifest?.path) throw new Error("manifesto da Limpeza sem caminho da Mídia");
        const cleanupSetup = await createCleanupProjectRuntime({
          input: resolve(manifest.path), workDir: dir, prefix, displayName: manifest.displayName, provider: opts.provider,
          providerConfigDir: opts.providerConfigDir, fetchImpl: opts.fetchImpl, env,
          now: opts.now, speech: opts.speech, triageFn: opts.triageFn, autoStart: opts.autoStart,
          exec, coordinator, visualEnv, visualDir, readStored, loadStored: globalLoadStored,
          page: cleanupPage,
        });
        return {
          handle: async (req, res) => { cleanupSetup.startIngest(); return cleanupSetup.runtime.handle(req, res); },
          close: async () => { await Promise.all([cleanupSetup.runtime.close(), cleanupSetup.closeSpeech()]); },
        };
      }
      const setup = await createAssemblyProjectRuntime({
        ...opts,
        dir,
        prefix,
        inputs: id === opts.projectId ? opts.inputs : undefined,
        exec,
        coordinator,
        visualEnv,
        visualDir,
        readStored,
        page,
        projectPathJs,
        pageCss,
        pageJs,
        media,
        teamMode,
        templatesRoot,
        port: () => boundPort,
        allowPaidModel,
        allowPaidVisual,
        alwaysTextConfigured: true,
      });
      return {
        handle: setup.runtime.handle,
        onJevDisabled: () => cancelAssemblyFillerNotes(dir),
        close: async () => {
          await Promise.all([setup.runtime.close(), setup.closeSpeech()]);
        },
      };
    },
  });

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (!guardLocalRequest(req, res, boundPort, network)) return;
      const url = parseRequestUrl(req.url);
      if (!url) { sendJson(res, { error: "URL inválida" }, 400); return; }
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort, network, req)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
      if (await auth.handlePublic(req, res, url)) return;
      if (!auth.authorize(req, res, url)) return;
      if (media && await media.handle(req, res)) return;
      if (await providerVisual(req, res, { dir: visualDir, env: visualEnv, loadStored: globalLoadStored, invalidateStored: readStored.invalidate, fetchImpl: opts.fetchImpl, loadUser: () => readStored(visualDir), includeAssemblyTextNotice: false, onJevDisabled: () => registry.notifyJevDisabled() })) return;
      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir, readStored)) return;
      if (await templates.handleTemplates(req, res)) return;
      const projectNew = req.method === "POST" && (url.pathname === "/project/new" || /^\/projects\/[^/]+\/project\/new$/.test(url.pathname));
      if (projectNew && (url.pathname === "/project/new" || await registry.isProjectPath(req.url))) {
        const created = await createAssemblyInProjectsRoot(projectsRoot);
        sendJson(res, { url: created.url, dir: created.dir }, 201);
        return;
      }
      if (url.pathname === "/" && opts.projectId) {
        res.writeHead(307, { location: `/projects/${opts.projectId}/`, "cache-control": "no-store" });
        res.end();
        return;
      }
      if (await registry.handle(req, res)) return;
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
    server.listen(opts.port ?? 7788, network.bindHost, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);
  boundPort = port;

  return {
    port,
    address: network.bindHost,
    jobId: opts.projectId ?? "",
    close: async () => {
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      const runtimesClosed = registry.close();
      const mediaClosed = media?.close() ?? Promise.resolve();
      const authClosed = auth.close();
      const closed = new Promise<void>((resolveClosed) => { server.close(() => resolveClosed()); server.closeAllConnections(); });
      await Promise.all([killed, runtimesClosed, mediaClosed, authClosed, closed]);
    },
    killChildren: () => { if (exec instanceof SpawnExecutor) exec.killNow(); },
  };
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

type CleanupProjectRuntimeOptions = {
  input: string;
  workDir: string;
  prefix?: string;
  displayName?: string;
  providerConfigDir?: string;
  provider?: string;
  executor?: Executor;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  speech?: IngestSpeech;
  triageFn?: (opts: {
    indexPath: string;
    videoPath: string;
    outDir: string;
    provider?: string;
    signal?: AbortSignal;
  }) => Promise<{ keepList: string }>;
  exec: Executor;
  autoStart?: boolean;
  coordinator?: ReturnType<typeof createHeavyCoordinator>;
  visualEnv: Record<string, string | undefined>;
  visualDir: string;
  readStored: ReturnType<typeof createCredentialsReader>;
  loadStored: () => ReturnType<typeof readAnalysisCredentials>;
  page: string;
};

type CleanupProjectRuntimeSetup = {
  runtime: ReturnType<typeof createCleanupRuntime>;
  jobId: string;
  exec: Executor;
  closeSpeech: () => Promise<void>;
  startIngest: () => void;
  onJevDisabled: () => void | Promise<void>;
};

async function createCleanupProjectRuntime(opts: CleanupProjectRuntimeOptions): Promise<CleanupProjectRuntimeSetup> {
  const { input, workDir, exec, provider, visualEnv, visualDir, readStored } = opts;
  // Antes do coordenador e de qualquer leitura: ele mora dentro da pasta, e
  // uma pasta de outra fonte vai inteira para o lado. O ingest roda uma vez
  // por processo, então conferir aqui cobre todo reuso da sessão.
  const { staleDir } = await claimWorkDir(workDir, input, opts.now, {
    flow: "limpeza", displayName: opts.displayName ?? basename(input),
  });
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
  // Sem sink: o traces nunca foi lido (sink morto); o tracer segue ativo
  // para as etapas do pipeline, sem coletar eventos em memória.
  const tracer = createTracer();

  const cleanup = createCleanupPlanning({ job: pipelineJob, exec, tracer, store,
    env: opts.env ?? process.env, fetchImpl: opts.fetchImpl, providerConfigDir: opts.providerConfigDir, loadStored: opts.loadStored,
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
        { requireSpeech: true, coordinator: opts.coordinator },
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
    const stored = await opts.loadStored();
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
      providerId = (await triageIdentity({ provider, projectDir: workDir, credentialsDir: visualDir, env: visualEnv })).providerId;
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

  const runtime = createCleanupRuntime({
    input, workDir, displayName: opts.displayName, provider: opts.provider, providerConfigDir: opts.providerConfigDir,
    fetchImpl: opts.fetchImpl, visualEnv, exec, pipelineJob, job, store, cleanup, ingestAbort,
    audioReady: () => audioReady, loadStored: opts.loadStored,
    prefix: opts.prefix,
    page: async () => withCleanupProject(withVisualNotice(opts.page.replace("window.__JOB__", JSON.stringify(job.id)), keyProviderState(visualEnv, await opts.loadStored(), false).notice), opts.prefix ?? ""),
    replan, triageReply, triageRequestKey, otioClipsForPlan,
    coordinator: opts.coordinator,
  });
  let initialIngestStarted = false;
  const startIngest = (): void => {
    if (opts.autoStart === false || initialIngestStarted) return;
    initialIngestStarted = true;
    void ingest();
  };
  return { runtime, jobId: job.id, exec, closeSpeech, startIngest,
    onJevDisabled: () => { cleanup.cancelNotes(); return cleanup.refreshNotes(); } };
}

async function startCleanupApp(opts: {
  input: string;
  port?: number;
  providerConfigDir?: string;
  coordinatorDir?: string;
  templatesRoot?: string;
  provider?: string;
  executor?: Executor;
  autoStart?: boolean;
  workDir?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  speech?: IngestSpeech;
  triageFn?: CleanupProjectRuntimeOptions["triageFn"];
}): Promise<AppHandle> {
  const env = opts.env ?? process.env;
  const network = resolveHostConfig(hostConfig(env));
  assertSafeBind(network, Boolean(env.DECUPA_AUTH_PASSWORD));
  const auth = await createAuthRuntime({ env, configDir: opts.providerConfigDir, network, now: opts.now });
  if (opts.providerConfigDir) await installCompanyCredentials(opts.providerConfigDir, opts.env ?? process.env);
  const input = resolve(opts.input);
  const exec = opts.executor ?? new SpawnExecutor();
  const visualEnv = { ...(opts.env ?? process.env) };
  const coordinator = opts.coordinatorDir || opts.providerConfigDir
    ? createHeavyCoordinator({ coordinatorDir: opts.coordinatorDir, configDir: opts.providerConfigDir, env: visualEnv })
    : undefined;
  resolveAssemblyTextProvider(visualEnv); // Campo inválido falha na subida, antes de qualquer envio.
  const visualDir = opts.providerConfigDir ?? homedir();
  const readStored = createCredentialsReader();
  const loadStored = () => readAnalysisCredentials(process.cwd(), visualDir, readStored);
  const page = await readFile(join(HERE, "page.html"), "utf8");
  const workDir = opts.workDir ?? cleanupWorkDir(input);
  const setup = await createCleanupProjectRuntime({ ...opts, input, workDir, exec, coordinator,
    visualEnv, visualDir, readStored, loadStored, page });
  const { runtime, jobId, closeSpeech, startIngest } = setup;
  let boundPort = opts.port ?? 7788;
  const media = await configuredMediaRuntime(opts.env, opts.now);

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (!guardLocalRequest(req, res, boundPort, network)) return;
      // Dentro do handle: `GET //` faz o `new URL` estourar, e fora do catch
      // isso derrubava o processo inteiro.
      const url = parseRequestUrl(req.url);
      if (!url) { sendJson(res, { error: "URL inválida" }, 400); return; }
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort, network, req)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
      if (await auth.handlePublic(req, res, url)) return;
      if (!auth.authorize(req, res, url)) return;
      if (media && await media.handle(req, res)) return;
      if (await providerVisual(req, res, { dir: visualDir, env: visualEnv, loadStored, invalidateStored: readStored.invalidate, fetchImpl: opts.fetchImpl, loadUser: () => readStored(visualDir), includeAssemblyTextNotice: false, onJevDisabled: setup.onJevDisabled })) return;
      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir, readStored)) return;
      startIngest();
      const handled = await runtime.handle(req, res);
      if (handled) return;
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
    server.listen(opts.port ?? 7788, network.bindHost, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);
  boundPort = port;

  if (opts.autoStart !== false && !opts.providerConfigDir) startIngest();

  return {
    port, address: network.bindHost, jobId,
    close: async () => {
      // Tudo é iniciado antes do primeiro await: no `exit` só o trecho
      // síncrono roda, e é nele que os filhos recebem o sinal.
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      const runtimeClosed = runtime.close();
      const mediaClosed = media?.close() ?? Promise.resolve();
      const authClosed = auth.close();
      const speechClosed = closeSpeech();
      const closed = new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.all([killed, runtimeClosed, mediaClosed, authClosed, speechClosed, closed]);
    },
    killChildren: () => { if (exec instanceof SpawnExecutor) exec.killNow(); },
  };
}

/**
 * Página da montagem com a pasta do projeto na meta `decupa-project-dir`
 * (o menu do projeto a mostra). O caminho entra escapado para atributo HTML.
 */
export function withProjectDir(
  page: string,
  dir: string,
  prefix = "",
  opts: { teamMode?: boolean; mediaEnabled?: boolean } = {},
): string {
  const escaped = dir.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  // Substituição por função: uma pasta com `$&`, `$$` ou `$\`` não é padrão de replace.
  return page
    .replace('<meta name="decupa-project-dir" content="">',
      () => `<meta name="decupa-project-dir" content="${escaped}">`)
    .replace('<meta name="decupa-project-prefix" content="">',
      () => `<meta name="decupa-project-prefix" content="${prefix}">`)
    .replace('<meta name="decupa-team-mode" content="">',
      () => `<meta name="decupa-team-mode" content="${opts.teamMode === true ? "true" : "false"}">`)
    .replace('<meta name="decupa-media-enabled" content="">',
      () => `<meta name="decupa-media-enabled" content="${opts.mediaEnabled === true ? "true" : "false"}">`)
    .replace("__DECUPA_PROJECT_CSS__", projectUrl("page.css", prefix))
    .replace("__DECUPA_PROJECT_JS__", projectUrl("page.js", prefix));
}

/** Injeta no app de Limpeza o mesmo prefixo que o registro usa para rotear. */
export function withCleanupProject(page: string, prefix = ""): string {
  return page.replace('<meta name="decupa-project-prefix" content="">',
    () => `<meta name="decupa-project-prefix" content="${prefix}">`);
}

async function loadAssemblyPageAssets(): Promise<{
  page: string;
  projectPathJs: string;
  pageCss: string;
  pageJs: string;
}> {
  return {
    page: await readFile(join(HERE, "assembly", "page.html"), "utf8"),
    projectPathJs: await readFile(join(HERE, "project-path.js"), "utf8"),
    pageCss: await readFile(join(HERE, "assembly", "page.css"), "utf8"),
    pageJs: await readFile(join(HERE, "assembly", "page.js"), "utf8"),
  };
}

async function createAssemblyProjectRuntime(opts: Omit<StartAppOptions, "port"> & {
  dir: string;
  prefix?: string;
  exec: Executor;
  coordinator?: ReturnType<typeof createHeavyCoordinator>;
  visualEnv: Record<string, string | undefined>;
  visualDir: string;
  readStored: ReturnType<typeof createCredentialsReader>;
  page: string;
  projectPathJs: string;
  pageCss: string;
  pageJs: string;
  templatesRoot: string;
  port: () => number;
  allowPaidModel: boolean;
  allowPaidVisual: boolean;
  media?: MediaRuntime;
  teamMode?: boolean;
  alwaysTextConfigured?: boolean;
}): Promise<{
  runtime: ReturnType<typeof createAssemblyRuntime>;
  project: Awaited<ReturnType<ReturnType<typeof createAssemblyRuntime>["ensureProject"]>>;
  loadStored: () => ReturnType<typeof readAnalysisCredentials>;
  transports: ReturnType<typeof resolveAppTransports>;
  speech?: IngestSpeech;
  closeSpeech: () => Promise<void>;
}> {
  const loadStored = () => readAnalysisCredentials(opts.dir, opts.visualDir, opts.readStored);
  const stored = await loadStored();
  const isTextConfigured = async (): Promise<boolean> => {
    try {
      const current = await loadStored();
      assemblyTextClientOptions({ stored: current, env: opts.visualEnv, selection: resolveAssemblyTextProvider(opts.visualEnv, current) });
      return true;
    } catch { return false; }
  };
  const transports = resolveAppTransports({ ...opts, stored, loadStored });
  const resolveOperationDeps = operationResolver({ dir: opts.dir, loadStored, env: opts.visualEnv, fetchImpl: opts.fetchImpl,
    describeClient: opts.describeClient, enableVisual: Boolean(opts.describeClient || opts.allowPaidVisual || opts.providerConfigDir),
    proposeSend: opts.proposeSend, enableText: Boolean(opts.proposeSend || opts.allowPaidModel || opts.providerConfigDir) });
  const { decision } = await resolveOperationDeps();
  opts.decisionLog?.(`provider=typesafe model=${decision.model} elapsedMs=0 fallback=${decision.mode === "off" ? "off" : "not-run"}`);
  const speech = attachResidentSpeech({
    dir: opts.dir,
    speech: opts.speech,
    executorInjected: Boolean(opts.executor),
  });
  try {
    const runtime = createAssemblyRuntime(opts.dir, {
      page: async () => withVisualNotice(withProjectDir(opts.page, opts.dir, opts.prefix, {
        teamMode: opts.teamMode === true,
        mediaEnabled: Boolean(opts.media),
      }), keyProviderState(opts.visualEnv, await loadStored()).notice),
      pageCss: opts.pageCss,
      pageJs: opts.pageJs,
      projectPathJs: opts.projectPathJs,
      templatesRoot: opts.templatesRoot,
      decision,
      exec: opts.exec,
      port: opts.port,
      selectFn: opts.selectFn,
      allowPaidModel: opts.allowPaidModel,
      allowPaidVisual: opts.allowPaidVisual,
      ...(opts.providerConfigDir || opts.alwaysTextConfigured ? { isTextConfigured } : {}),
      proposeSend: opts.proposeSend ?? ((opts.allowPaidModel || opts.providerConfigDir) ? transports.textSend : undefined),
      describeClient: opts.describeClient ?? ((opts.allowPaidVisual || opts.providerConfigDir) ? transports.visualClient : undefined),
      resolveOperationDeps,
      fillerFetchImpl: opts.fetchImpl,
      speech: speech.speech,
      coordinator: opts.coordinator,
      media: opts.media,
      teamMode: opts.teamMode,
    });
    const project = await runtime.ensureProject(opts.inputs);
    return { runtime, project, loadStored, transports, speech: speech.speech, closeSpeech: speech.closeSpeech };
  } catch (error) {
    await speech.closeSpeech();
    throw error;
  }
}

async function startAssemblyApp(opts: {
  projectDir: string;
  inputs?: string[];
  port?: number;
  providerConfigDir?: string;
  coordinatorDir?: string;
  templatesRoot?: string;
  executor?: Executor;
  selectFn?: AssemblyDeps["selectFn"];
  proposeSend?: AssemblyDeps["proposeSend"];
  describeClient?: AssemblyDeps["describeClient"];
  allowPaidModel?: boolean;
  allowPaidVisual?: boolean;
  speech?: IngestSpeech;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  decisionLog?: (line: string) => void;
}): Promise<AppHandle> {
  const env = opts.env ?? process.env;
  const network = resolveHostConfig(hostConfig(env));
  assertSafeBind(network, Boolean(env.DECUPA_AUTH_PASSWORD));
  const auth = await createAuthRuntime({ env, configDir: opts.providerConfigDir, network, now: opts.now });
  if (opts.providerConfigDir) {
    await installCompanyCredentials(opts.providerConfigDir, opts.env ?? process.env);
  }
  const dir = resolve(opts.projectDir);
  const teamMode = auth.enabled || !isLoopbackBind(network.bindHost);
  const visualEnv = { ...(opts.env ?? process.env) };
  const coordinator = opts.coordinatorDir || opts.providerConfigDir
    ? createHeavyCoordinator({ coordinatorDir: opts.coordinatorDir, configDir: opts.providerConfigDir, env: visualEnv })
    : undefined;
  const visualDir = opts.providerConfigDir ?? homedir();
  const readStored = createCredentialsReader();
  const exec = opts.executor ?? new SpawnExecutor();
  const { page, projectPathJs, pageCss, pageJs } = await loadAssemblyPageAssets();
  let boundPort = opts.port ?? 7788;
  const allowPaidModel = opts.allowPaidModel === true;
  const allowPaidVisual = opts.allowPaidVisual === true;
  const media = await configuredMediaRuntime(opts.env, opts.now);
  const templatesRoot=opts.templatesRoot??join(opts.providerConfigDir??homedir(),".decupa","templates");
  const setup = await createAssemblyProjectRuntime({
    ...opts,
    dir,
    exec,
    coordinator,
    visualEnv,
    visualDir,
    readStored,
    page,
    projectPathJs,
    pageCss,
    pageJs,
    media,
    teamMode,
    templatesRoot,
    port: () => boundPort,
    allowPaidModel,
    allowPaidVisual,
  });
  const { runtime, project, loadStored, transports, speech, closeSpeech } = setup;
  const templates=createTemplateRuntime(templatesRoot,{
    port:()=>boundPort,selectFn:opts.selectFn,exec,speech,
    send:transports.textSend,visualClient:transports.visualClient,
    modelKey:transports.textKey,legacyModelKey:transports.legacyModelKey,legacyVisualCompatible:transports.legacyVisualCompatible,
    resolveAnalysis:transports.resolveAnalysis,
    allowModel:allowPaidModel,allowVisual:allowPaidVisual,
  });
  const newProjects: AppHandle[] = [];

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (!guardLocalRequest(req, res, boundPort, network)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort, network, req)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
      if (await auth.handlePublic(req, res, url)) return;
      if (!auth.authorize(req, res, url)) return;
      if (media && await media.handle(req, res)) return;
      if (await providerVisual(req, res, { dir: visualDir, env: visualEnv, loadStored, invalidateStored: readStored.invalidate, fetchImpl: opts.fetchImpl, loadUser: () => readStored(visualDir), onJevDisabled: () => cancelAssemblyFillerNotes(dir) })) return;
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


      if(await templates.handleTemplates(req,res))return;
      const handled = await runtime.handle(req, res);
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
    server.listen(opts.port ?? 7788, network.bindHost, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);
  boundPort = port;

  return {
    port, address: network.bindHost, jobId: project.id,
    close: async () => {
      // Tudo é iniciado antes do primeiro await: no `exit` só o trecho
      // síncrono roda, e é nele que os filhos e o worker de fala morrem.
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      const runtimeClosed = runtime.close();
      const mediaClosed = media?.close() ?? Promise.resolve();
      const authClosed = auth.close();
      const speechClosed = closeSpeech();
      const nested = Promise.all(newProjects.map(app => app.close()));
      const closed = new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.all([killed, runtimeClosed, mediaClosed, authClosed, speechClosed, nested, closed]);
    },
    killChildren: () => {
      if (exec instanceof SpawnExecutor) exec.killNow();
      for (const app of newProjects) app.killChildren();
    },
  };
}
