import { initializeResourceLedger, safeSyncProject, type ResourceLedger } from "./resource-ledger.ts";
import { createTemplateRuntime } from "./templates/routes.ts";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CancelledError, createTracer } from "@decupa/trace";
import { createOperationMetrics, instrumentCoordinator, instrumentSpeechWorker, type OperationMetrics } from "@decupa/bench";
import { createCredentialsReader, installCompanyCredentials, readAnalysisCredentials, resolveAssemblyTextProvider, resolveVisualProvider, assemblyTextClientOptions } from "@decupa/triage";
import { resolveAppTransports } from "./analysis-transports.ts";
import { providerSetup } from "./provider-setup.ts";
import { keyProviderState, providerVisual, withVisualNotice } from "./provider-visual.ts";
import { operationResolver } from "./analysis-operation.ts";
import { cancelAssemblyFillerNotes } from "./assembly/filler-observe.ts";
import { access, readFile, mkdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeBind, guardLocalRequest, hostConfig, isLoopbackBind, originAllowed, resolveHostConfig } from "../http/origin.ts";
import type { Assembly } from "./assembly/types.ts";
import { JobStore, stableCleanupJobId } from "./jobs.ts";
import { createCleanupPlanning } from "../condense/cleanup-planning.ts";
import {
  ensureAudioProxy, indexPath, preflight, runIngest, runTriage, SpawnExecutor,
  visualIndexPath, type Executor, type IngestSpeech, type PipelineJob,
} from "./pipeline.ts";
import { triageIdentity } from "../triage.ts";
import type { ReviewUnitFlag } from "./review.ts";
import { editorialStats } from "./stats.ts";
import { claimWorkDir, cleanupWorkDir, readSourceManifest } from "./session.ts";
import { blankProject, createAssemblyRuntime, sourceFromMedia, withCanvasPolicy, type AssemblyDeps } from "./assembly/routes.ts";
import type { Source } from "./assembly/types.ts";
import { createProject } from "./assembly/store.ts";
import type { VisualClient } from "./assembly/model.ts";
import { BodyTooLargeError, createCleanupRuntime } from "./cleanup/routes.ts";
import { createHeavyCoordinator } from "./heavy-work.ts";
import { createMediaRuntime, type MediaRuntime } from "./media-runtime.ts";
import { projectUrl } from "./project-url.ts";
import { createProjectRuntimeRegistry, listProjectRootEntries, PROJECT_ID_PATTERN } from "./project-root.ts";
import { createAuthRuntime, requestIdentity } from "./auth.ts";
import { requireEditReservation } from "./edit-reservation.ts";
import { createServerSpeechRuntime, type ServerSpeechRuntime } from "./speech-runtime.ts";

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function sendProjectRootPage(res: ServerResponse, page: string, identity: string | undefined, mediaEnabled: boolean, driveEnabled: boolean): void {
  const rendered = page
    .replace("__DECUPA_USER__", () => escapeHtml(identity ?? "usuário local"))
    .replace('<meta name="decupa-media-enabled" content="">',
      () => `<meta name="decupa-media-enabled" content="${mediaEnabled ? "true" : "false"}">`)
    .replace('<meta name="decupa-drive-enabled" content="">',
      () => `<meta name="decupa-drive-enabled" content="${driveEnabled ? "true" : "false"}">`);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(rendered),
    "cache-control": "no-store",
  });
  res.end(rendered);
}

function projectSlug(name: string): string {
  const slug = name.normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "projeto";
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let size = 0;
  for (const character of value) {
    const characterSize = Buffer.byteLength(character, "utf8");
    if (size + characterSize > maxBytes) break;
    result += character;
    size += characterSize;
  }
  return result.replace(/-+$/, "");
}

async function readProjectCreationBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("corpo do pedido excede 1 MiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new Error("corpo do pedido inválido");
  }
}

async function reserveProjectDirectory(
  projectsRoot: string,
  displayName: string,
  initialize: (dir: string) => Promise<void>,
): Promise<{ id: string; url: string }> {
  // Mantém folga para o hífen e os quatro caracteres aleatórios do sufixo.
  const slug = truncateUtf8(projectSlug(displayName), 240);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `${slug}-${randomUUID().replace(/-/g, "").slice(0, 4)}`;
    const dir = join(projectsRoot, id);
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await initialize(dir);
      return { id, url: `/projects/${encodeURIComponent(id)}/` };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error("não foi possível reservar uma pasta para o novo Projeto");
}

async function createAssemblyInProjectsRoot(
  projectsRoot: string,
  displayName: string,
  sources: Source[] = [],
  bindProject?: (dir: string) => Promise<void>,
): Promise<{ id: string; url: string }> {
  return reserveProjectDirectory(projectsRoot, displayName, async (dir) => {
    await bindProject?.(dir);
    const empty = blankProject(randomUUID(), displayName);
    const project = sources.length === 0 ? empty : withCanvasPolicy({
      ...empty,
      assembly: { ...empty.assembly, sources },
    });
    await createProject(dir, project);
  });
}

async function createCleanupInProjectsRoot(
  projectsRoot: string,
  displayName: string,
  media: Pick<MediaRuntime, "getMedia">,
  mediaId: string,
  now?: () => number,
  bindProject?: (dir: string) => Promise<void>,
): Promise<{ id: string; url: string }> {
  const record = await media.getMedia(mediaId);
  if (!record) throw Object.assign(new Error("Mídia não encontrada no acervo"), { status: 404 });
  return reserveProjectDirectory(projectsRoot, displayName, async (dir) => {
      await bindProject?.(dir);
      // source.json é o manifesto que faz o registro tratar a pasta como
      // Limpeza. A pasta continua na Raiz, mas o arquivo nunca é copiado.
      await claimWorkDir(dir, record.path, now, { flow: "limpeza", displayName });
      await safeSyncProject(dir, { assembly: { sources: [{ sha256: mediaId }] } });
  });
}

function projectCreationStatus(error: unknown): number {
  const status = error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status) : 0;
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
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
  const manager = createServerSpeechRuntime({
    speech: opts.speech,
    executorInjected: opts.executorInjected,
    env: process.env,
  });
  return { ...manager.attach(opts.dir), closeSpeech: manager.close };
}

type StartAppOptions = {
  input?: string;
  projectDir?: string;
  projectsRoot?: string;
  /** A CLI mantém o pai para as URLs legadas, mas só possui este Projeto. */
  ledgerScope?: "project";
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
  /** Runtime de fala compartilhado; usado pela fronteira HTTP e pelos testes. */
  speechRuntime?: ServerSpeechRuntime;
  env?: Record<string, string | undefined>;
  /** Relógio do acervo; nos testes permite envelhecer envios sem esperar. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  decisionLog?: (line: string) => void;
};

async function withBootLedger(opts: Parameters<typeof initializeResourceLedger>[0], start: (ledger: ResourceLedger) => Promise<AppHandle>): Promise<AppHandle> {
  const ledger = await initializeResourceLedger({ ...opts, deferReconciliation: true });
  try { return await start(ledger); }
  catch (error) { ledger.cancelPendingReconciliation(); throw error; }
}

export async function startApp(opts: StartAppOptions): Promise<AppHandle> {
  resolveVisualProvider(opts.env ?? process.env);
  const env = opts.env ?? process.env;
  if (opts.projectsRoot) {
    const projectsRoot = resolve(opts.projectsRoot);
    const projectId = opts.projectId ?? (opts.projectDir ? basename(resolve(opts.projectDir)) : undefined);
    if (projectId !== undefined && !PROJECT_ID_PATTERN.test(projectId)) throw new Error("id de Projeto inválido");
    const initialDir = projectId ? resolve(opts.projectDir ?? join(projectsRoot, projectId)) : undefined;
    if (initialDir && (dirname(initialDir) !== projectsRoot || basename(initialDir) !== projectId)) throw new Error("Projeto inicial fora da Raiz");
    if (opts.ledgerScope === "project" && !initialDir) throw new Error("escopo do Projeto precisa de projectDir ou projectId");
    const ledgerProjectDir = opts.ledgerScope === "project" ? initialDir : undefined;
    return withBootLedger({
      root: env.DECUPA_MEDIA_ROOT ?? ledgerProjectDir ?? projectsRoot,
      ...(ledgerProjectDir ? { projectDir: ledgerProjectDir } : { projectsRoot }), now: opts.now, env,
    }, ledger => startProjectRootApp({ ...opts, projectsRoot, projectId }, ledger));
  }
  if (opts.projectDir && !opts.input) {
    const dir = resolve(opts.projectDir);
    return withBootLedger({ root: env.DECUPA_MEDIA_ROOT ?? dir, projectDir: dir, now: opts.now, env },
      ledger => startAssemblyApp({ ...opts, projectDir: dir }, ledger));
  }
  if (!opts.input) throw new Error("startApp precisa de input ou projectDir");
  return startCleanupApp({ ...opts, input: opts.input });
}

async function startProjectRootApp(opts: StartAppOptions & { projectsRoot: string }, ledger: ResourceLedger): Promise<AppHandle> {
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
    const initialDir = resolve(opts.projectDir ?? resolve(projectsRoot, opts.projectId));
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
  const speechRuntime = opts.speechRuntime ?? createServerSpeechRuntime({
    speech: opts.speech, executorInjected: Boolean(opts.executor), env, now: opts.now,
  });
  const visualDir = opts.providerConfigDir ?? homedir();
  const readStored = createCredentialsReader();
  const globalLoadStored = () => readAnalysisCredentials(projectsRoot, visualDir, readStored);
  const globalStored = await globalLoadStored();
  const globalTransports = resolveAppTransports({ ...opts, stored: globalStored, loadStored: globalLoadStored });
  const { page, projectPathJs, editReservationUiJs, pageCss, pageJs } = await loadAssemblyPageAssets();
  const hubPage = await readFile(join(HERE, "hub", "page.html"), "utf8");
  const hubCss = await readFile(join(HERE, "hub", "page.css"), "utf8");
  // O envio da gaveta é o cliente do editor da Montagem, servido daqui e não copiado:
  // retomada e mensagens de erro ficam iguais nos dois lugares.
  const hubScripts = new Map<string, string>([
    ["/hub/page.js", await readFile(join(HERE, "hub", "page.js"), "utf8")],
    ["/hub/gaveta.js", await readFile(join(HERE, "hub", "gaveta.js"), "utf8")],
    ["/hub/media-upload.js", await readFile(join(HERE, "assembly", "editor", "media-upload.js"), "utf8")],
  ]);
  const cleanupPage = await readFile(join(HERE, "page.html"), "utf8");
  let boundPort = opts.port ?? 7788;
  const allowPaidModel = opts.allowPaidModel === true;
  const allowPaidVisual = opts.allowPaidVisual === true;
  const templatesRoot = opts.templatesRoot ?? join(opts.providerConfigDir ?? homedir(), ".decupa", "templates");
  const templates = createTemplateRuntime(templatesRoot, {
    getMedia: media ? id => media.getMedia(id) : undefined,
    port: () => boundPort,
    originConfig: network,
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

  // As rotas legadas podem abrir/criar outro Projeto por ação explícita.
  // Vincula somente esse diretório, sem transformar o pai em raiz de busca.
  const projectBindings = new Map<string, Promise<void>>();
  const bindProject = opts.ledgerScope === "project" ? async (dir: string): Promise<void> => {
    if (resolve(dir) === ledger.projectDir) return;
    let binding = projectBindings.get(dir);
    if (!binding) {
      binding = initializeResourceLedger({ root: env.DECUPA_MEDIA_ROOT ?? dir, projectDir: dir, now: opts.now, env }).then(() => undefined);
      projectBindings.set(dir, binding);
    }
    await binding;
  } : undefined;
  const registry = createProjectRuntimeRegistry({
    projectsRoot,
    now: opts.now,
    createRuntime: async ({ id, dir, prefix, kind }) => {
      await bindProject?.(dir);
      if (kind === "cleanup") {
        const manifest = await readSourceManifest(dir);
        if (!manifest?.path) throw new Error("manifesto da Limpeza sem caminho da Mídia");
        const cleanupSetup = await createCleanupProjectRuntime({
          input: resolve(manifest.path), workDir: dir, prefix, displayName: manifest.displayName, provider: opts.provider,
          providerConfigDir: opts.providerConfigDir, fetchImpl: opts.fetchImpl, env,
          now: opts.now, speech: opts.speech, triageFn: opts.triageFn, autoStart: opts.autoStart,
          speechRuntime,
          exec, coordinator, visualEnv, visualDir, readStored, loadStored: globalLoadStored,
          page: cleanupPage,
        });
        return {
          handle: async (req, res) => { cleanupSetup.startIngest(); return cleanupSetup.runtime.handle(req, res); },
          onJevDisabled: cleanupSetup.onJevDisabled,
          isBusy: cleanupSetup.runtime.isBusy,
          close: cleanupSetup.close,
        };
      }
      const setup = await createAssemblyProjectRuntime({
        ...opts,
        dir,
        prefix,
        inputs: id === opts.projectId ? opts.inputs : undefined,
        speechRuntime,
        exec,
        coordinator,
        visualEnv,
        visualDir,
        readStored,
        page,
        projectPathJs,
        editReservationUiJs,
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
        isBusy: setup.runtime.isBusy,
        onJevDisabled: () => cancelAssemblyFillerNotes(dir),
        close: async () => {
          await setup.runtime.close();
        },
      };
    },
  });

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      await speechRuntime.sweep();
      if (!guardLocalRequest(req, res, boundPort, network)) return;
      const url = parseRequestUrl(req.url);
      if (!url) { sendJson(res, { error: "URL inválida" }, 400); return; }
      // `new URL` normaliza `%2e%2e` para `/`; não deixe um pedido de outro
      // caminho ganhar a página da Raiz por causa dessa normalização.
      const isRootRequest = url.pathname === "/" && (req.url ?? "/").split("?", 1)[0] === "/";
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort, network, req)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
      if (await auth.handlePublic(req, res, url)) return;
      if (!auth.authorize(req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/hub/page.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
        res.end(hubCss);
        return;
      }
      const hubScript = req.method === "GET" ? hubScripts.get(url.pathname) : undefined;
      if (hubScript !== undefined) {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(hubScript);
        return;
      }
      if (url.pathname === "/api/projects") {
        if (req.method !== "GET") {
          sendJson(res, { error: "método inválido" }, 405);
          return;
        }
        const entries = await listProjectRootEntries(projectsRoot, opts.now);
        sendJson(res, entries.map(project => ({
          id: project.id,
          nome: project.displayName,
          fluxo: project.flow,
          atualizadoEm: project.updatedAt,
          reserva: project.reservation,
          ...(project.problem ? { problema: project.problem } : {}),
        })));
        return;
      }
      if (media && await media.handle(req, res)) return;
      if (await providerVisual(req, res, { dir: visualDir, env: visualEnv, loadStored: globalLoadStored, invalidateStored: readStored.invalidate, fetchImpl: opts.fetchImpl, loadUser: () => readStored(visualDir), includeAssemblyTextNotice: false, onJevDisabled: () => registry.notifyJevDisabled() })) return;
      if (opts.providerConfigDir && await providerSetup(req, res, opts.providerConfigDir, readStored)) return;
      if (await templates.handleTemplates(req, res)) return;
      const projectNew = req.method === "POST" && (url.pathname === "/project/new" || /^\/projects\/[^/]+\/project\/new$/.test(url.pathname));
      if (projectNew && (url.pathname === "/project/new" || await registry.isProjectPath(req.url))) {
        if (url.pathname !== "/project/new") {
          const match = /^\/projects\/([^/]+)\/project\/new$/.exec(url.pathname);
          let id: string | undefined;
          try { id = match ? decodeURIComponent(match[1]!) : undefined; } catch { id = undefined; }
          const projectDir = id && PROJECT_ID_PATTERN.test(id) ? resolve(projectsRoot, id) : null;
          if (!projectDir || dirname(projectDir) !== projectsRoot
            || !await requireEditReservation(req, res, {
              projeto: projectDir,
              now: opts.now ?? Date.now,
              identity: requestIdentity,
            })) return;
        }
        let body: Record<string, unknown>;
        try {
          body = await readProjectCreationBody(req);
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 400);
          return;
        }
        const displayName = typeof body.nome === "string" ? body.nome.trim() : "";
        if (!displayName) {
          sendJson(res, { error: "nome precisa ser um texto não vazio" }, 400);
          return;
        }
        const rawMediaIds = body.midias;
        if (rawMediaIds !== undefined && !Array.isArray(rawMediaIds)) {
          sendJson(res, { error: "midias precisa ser uma lista" }, 400);
          return;
        }
        const mediaIds: string[] = rawMediaIds === undefined
          ? []
          : rawMediaIds.map((mediaId) => typeof mediaId === "string" ? mediaId : "");
        if (mediaIds.some((mediaId) => typeof mediaId !== "string" || !mediaId.trim())) {
          sendJson(res, { error: "midias contém um id inválido" }, 400);
          return;
        }
        if (body.fluxo === "limpeza" && mediaIds.length !== 1) {
          sendJson(res, { error: "Limpeza precisa de exatamente uma Mídia" }, 400);
          return;
        }
        if (body.fluxo !== "montagem" && body.fluxo !== "limpeza") {
          sendJson(res, { error: "fluxo precisa ser montagem ou limpeza" }, 400);
          return;
        }
        if (mediaIds.length > 0 && !media) {
          sendJson(res, { error: "acervo de Mídias indisponível" }, 503);
          return;
        }
        const sources: Source[] = [];
        if (body.fluxo === "montagem") {
          // A mesma Mídia pedida duas vezes vira uma fonte só (o acervo é por
          // hash); os probes das Mídias distintas rodam em paralelo.
          const unique = [...new Set(mediaIds.map((mediaId) => mediaId.toLowerCase()))];
          sources.push(...await Promise.all(unique.map((mediaId) => sourceFromMedia(media!, mediaId, `src-${randomUUID()}`))));
        }
        const created = body.fluxo === "limpeza"
          ? await createCleanupInProjectsRoot(projectsRoot, displayName, media!, mediaIds[0]!.toLowerCase(), opts.now, bindProject)
          : await createAssemblyInProjectsRoot(projectsRoot, displayName, sources, bindProject);
        sendJson(res, { id: created.id, url: created.url }, 201);
        return;
      }
      if (isRootRequest && opts.projectId) {
        res.writeHead(307, { location: `/projects/${encodeURIComponent(opts.projectId)}/`, "cache-control": "no-store" });
        res.end();
        return;
      }
      if (isRootRequest && req.method === "GET") {
        sendProjectRootPage(res, hubPage, requestIdentity(req), media !== undefined, media?.driveEnabled === true);
        return;
      }
      if (await registry.handle(req, res)) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("não encontrado");
    };
    handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, { error: message }, projectCreationStatus(error));
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

  const reconciliationAbort = new AbortController();
  const reconciliation = ledger.reconcile({ signal: reconciliationAbort.signal }).catch(error => {
    if (reconciliationAbort.signal.aborted && error === reconciliationAbort.signal.reason) ledger.cancelPendingReconciliation();
    else ledger.markIncomplete(error);
  });
  return {
    port,
    address: network.bindHost,
    jobId: opts.projectId ?? "",
    close: async () => {
      reconciliationAbort.abort();
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      const runtimesClosed = registry.close();
      const speechClosed = speechRuntime.close();
      const mediaClosed = media?.close() ?? Promise.resolve();
      const authClosed = auth.close();
      const closed = new Promise<void>((resolveClosed) => { server.close(() => resolveClosed()); server.closeAllConnections(); });
      await Promise.all([killed, runtimesClosed, speechClosed, mediaClosed, authClosed, closed, reconciliation]);
    },
    killChildren: () => {
      if (exec instanceof SpawnExecutor) exec.killNow();
      speechRuntime.killChildren();
    },
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
  speechRuntime?: ServerSpeechRuntime;
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
  close: () => Promise<void>;
  startIngest: () => void;
  onJevDisabled: () => void | Promise<void>;
};

async function createCleanupProjectRuntime(opts: CleanupProjectRuntimeOptions): Promise<CleanupProjectRuntimeSetup> {
  const { input, workDir, exec, provider, visualEnv, visualDir } = opts;
  // Antes do coordenador e de qualquer leitura: ele mora dentro da pasta, e
  // uma pasta de outra fonte vai inteira para o lado. O ingest roda uma vez
  // por processo, então conferir aqui cobre todo reuso da sessão.
  const { staleDir } = await claimWorkDir(workDir, input, opts.now, {
    flow: "limpeza", displayName: opts.displayName ?? basename(input),
  });
  if (staleDir) console.log(`a fonte mudou desde a última sessão; os arquivos antigos foram para ${staleDir}`);
  await mkdir(join(workDir, "out"), { recursive: true });
  const speechSetup = opts.speechRuntime
    ? { ...opts.speechRuntime.attach(workDir), closeSpeech: async () => undefined }
    : attachResidentSpeech({ dir: workDir, speech: opts.speech, executorInjected: Boolean(opts.executor) });
  const { speech, closeSpeech } = speechSetup;
  const ingestAbort = new AbortController();

  const store = new JobStore();
  const job = store.create({ videoPath: input, workDir, id: stableCleanupJobId(workDir) });
  const pipelineJob: PipelineJob = { id: job.id, videoPath: input, workDir, signal: store.signal(job.id) };
  // A journal stays owned until its final append completes, including closes
  // launched by the tracer (which deliberately does not await its sink).
  const journals = new Set<OperationMetrics>();
  const journalCloses = new Map<OperationMetrics, Promise<void>>();
  const openJournal = (operation: string, operationId?: string): OperationMetrics => {
    const metrics = createOperationMetrics({ dir: join(workDir, ".decupa", "metrics"),
      operationId, metadata: { jobId: job.id, operation } });
    journals.add(metrics);
    return metrics;
  };
  const closeJournal = (metrics: OperationMetrics): Promise<void> => {
    const existing = journalCloses.get(metrics);
    if (existing) return existing;
    const closed = metrics.close().finally(() => {
      journals.delete(metrics);
      journalCloses.delete(metrics);
    });
    journalCloses.set(metrics, closed);
    return closed;
  };
  let closing: Promise<void> | undefined;
  const traceWork = new Set<Promise<unknown>>();
  // Each traced attempt has its own journal, including later cleanup replans.
  const traceOperations = new Map<string, OperationMetrics>();
  const sinkTracer = createTracer({ emit(event) {
    let metrics = traceOperations.get(event.attemptId);
    if (!metrics) {
      metrics = openJournal(event.stage, event.attemptId);
      traceOperations.set(event.attemptId, metrics);
    }
    metrics.emit("trace", event);
    if (event.phase === "finished") {
      traceOperations.delete(event.attemptId);
      return closeJournal(metrics);
    }
  } });
  const tracer: typeof sinkTracer = {
    run(stage, work, options) {
      // Replans can reach the tracer after awaiting their input files.
      if (closing) return Promise.reject(new CancelledError());
      const pending = sinkTracer.run(stage, work, options);
      traceWork.add(pending);
      const settled = (): void => { traceWork.delete(pending); };
      void pending.then(settled, settled);
      return pending;
    },
  };

  const cleanup = createCleanupPlanning({ job: pipelineJob, exec, tracer, store,
    env: opts.env ?? process.env, fetchImpl: opts.fetchImpl, providerConfigDir: opts.providerConfigDir, loadStored: opts.loadStored,
    visual: () => maybeVisual(pipelineJob), flags: () => maybeInspectFlags(workDir) });
  const replan = cleanup.replan;

  // Proxy só de áudio para os botões "ouvir": gerado em paralelo ao ingest,
  // a página passa a usá-lo quando o poll avisa (`audio: true`).
  let audioReady = false;
  let ingestInFlight = false;
  let ingestFlight: Promise<void> | undefined;

  async function ingest(): Promise<void> {
    const metrics = openJournal("ingest");
    const ingestExec: Executor = { run: call => {
      // Preflight helpers may omit a signal; shutdown still owns every call.
      const signal = call.signal ?? pipelineJob.signal;
      return metrics.tracer.run(`process:${basename(call.command)}`, async () => {
        const result = await exec.run({ ...call, signal });
        metrics.emit("process-call", { command: basename(call.command), code: result.code });
        return result;
      }, { signal });
    } };
    const ingestSpeech = speech ? { ...speech,
      worker: instrumentSpeechWorker(speech.worker, metrics),
      coordinator: instrumentCoordinator(speech.coordinator, metrics),
    } : undefined;
    ingestInFlight = true;
    void ensureAudioProxy(pipelineJob, exec).then((ok) => { audioReady = ok; }, () => {});
    try {
      await metrics.tracer.run("preflight", () => preflight(pipelineJob, ingestExec));
      const ingestResult = await runIngest(
        pipelineJob,
        ingestExec,
        (stage) => { metrics.emit("stage", { stage }); store.setStage(job.id, stage); },
        (line) => store.setProgress(job.id, line),
        metrics.tracer,
        ingestSpeech,
        ingestAbort.signal,
        { requireSpeech: true, coordinator: instrumentCoordinator(opts.coordinator, metrics) },
      );
      if (ingestResult.warning) store.setWarning(job.id, ingestResult.warning);
      if (store.get(job.id)?.stage === "cancelled") return;
      // A recuperação do par acontece antes de escolher o keep-list retomado.
      await replan();
    } catch (error) {
      // `fail` não sobrescreve `cancelled`: matar o processo faz a etapa
      // falhar, e esse erro não é notícia para quem pediu para parar.
      store.fail(job.id, error instanceof Error ? error.message : String(error));
    } finally {
      ingestInFlight = false;
      const stage = store.get(job.id)?.stage;
      metrics.emit("ingest-result", { stage, category: stage === "cancelled" ? "cancelled" : stage === "error" ? "error" : "ok" });
      await closeJournal(metrics);
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

  let ingestStarted = false;
  const runtime = createCleanupRuntime({
    input, workDir, displayName: opts.displayName, provider: opts.provider, providerConfigDir: opts.providerConfigDir,
    fetchImpl: opts.fetchImpl, visualEnv, exec, pipelineJob, job, store, cleanup, ingestAbort,
    audioReady: () => audioReady, loadStored: opts.loadStored,
    prefix: opts.prefix,
    page: async () => withCleanupProject(withVisualNotice(opts.page.replace("window.__JOB__", JSON.stringify(job.id)), keyProviderState(visualEnv, await opts.loadStored(), false).notice), opts.prefix ?? ""),
    replan, triageReply, triageRequestKey, otioClipsForPlan,
    coordinator: opts.coordinator, now: opts.now, identity: requestIdentity,
    busy: () => ingestInFlight || (ingestStarted && Boolean(store.get(job.id)?.stage
      && !["ready", "error", "cancelled"].includes(store.get(job.id)!.stage))),
  });
  let initialIngestStarted = false;
  const startIngest = (): void => {
    if (closing || opts.autoStart === false || initialIngestStarted) return;
    initialIngestStarted = true;
    ingestStarted = true;
    ingestFlight = ingest();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    // Cancel before the first await; the app also stops executors and speech
    // synchronously. Let producers emit their terminal events before draining.
    const runtimeClosed = runtime.close();
    closing = (async () => {
      const results = await Promise.allSettled([runtimeClosed, ingestFlight]);
      while (traceWork.size) await Promise.allSettled(traceWork);
      await Promise.all([...journals].map(closeJournal));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return closing;
  };
  return { runtime, jobId: job.id, exec, closeSpeech, close, startIngest,
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
  speechRuntime?: ServerSpeechRuntime;
  triageFn?: CleanupProjectRuntimeOptions["triageFn"];
}): Promise<AppHandle> {
  const env = opts.env ?? process.env;
  const network = resolveHostConfig(hostConfig(env));
  assertSafeBind(network, Boolean(env.DECUPA_AUTH_PASSWORD));
  const auth = await createAuthRuntime({ env, configDir: opts.providerConfigDir, network, now: opts.now });
  if (opts.providerConfigDir) await installCompanyCredentials(opts.providerConfigDir, opts.env ?? process.env);
  const input = resolve(opts.input);
  const exec = opts.executor ?? new SpawnExecutor();
  const speechRuntime = opts.speechRuntime ?? createServerSpeechRuntime({
    speech: opts.speech, executorInjected: Boolean(opts.executor), env, now: opts.now,
  });
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
    visualEnv, visualDir, readStored, loadStored, page, speechRuntime });
  const { runtime, jobId, closeSpeech, close: closeRuntime, startIngest } = setup;
  let boundPort = opts.port ?? 7788;
  const media = await configuredMediaRuntime(opts.env, opts.now);

  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      await speechRuntime.sweep();
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
      const runtimeClosed = closeRuntime();
      const mediaClosed = media?.close() ?? Promise.resolve();
      const authClosed = auth.close();
      const speechClosed = closeSpeech();
      const serverSpeechClosed = speechRuntime.close();
      const closed = new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.all([killed, runtimeClosed, mediaClosed, authClosed, speechClosed, serverSpeechClosed, closed]);
    },
    killChildren: () => {
      if (exec instanceof SpawnExecutor) exec.killNow();
      speechRuntime.killChildren();
    },
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
  editReservationUiJs: string;
  pageCss: string;
  pageJs: string;
}> {
  return {
    page: await readFile(join(HERE, "assembly", "page.html"), "utf8"),
    projectPathJs: await readFile(join(HERE, "project-path.js"), "utf8"),
    pageCss: await readFile(join(HERE, "assembly", "page.css"), "utf8"),
    pageJs: await readFile(join(HERE, "assembly", "page.js"), "utf8"),
    editReservationUiJs: await readFile(join(HERE, "edit-reservation-ui.js"), "utf8"),
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
  editReservationUiJs: string;
  pageCss: string;
  pageJs: string;
  templatesRoot: string;
  port: () => number;
  allowPaidModel: boolean;
  allowPaidVisual: boolean;
  media?: MediaRuntime;
  teamMode?: boolean;
  alwaysTextConfigured?: boolean;
  speechRuntime?: ServerSpeechRuntime;
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
  const speech = opts.speechRuntime
    ? { ...opts.speechRuntime.attach(opts.dir), closeSpeech: async () => undefined }
    : attachResidentSpeech({ dir: opts.dir, speech: opts.speech, executorInjected: Boolean(opts.executor) });
  try {
    const runtime = createAssemblyRuntime(opts.dir, {
      page: async () => withVisualNotice(withProjectDir(opts.page, opts.dir, opts.prefix, {
        teamMode: opts.teamMode === true,
        mediaEnabled: Boolean(opts.media),
      }), keyProviderState(opts.visualEnv, await loadStored()).notice),
      pageCss: opts.pageCss,
      pageJs: opts.pageJs,
      projectPathJs: opts.projectPathJs,
      editReservationUiJs: opts.editReservationUiJs,
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
      now: opts.now,
      identity: requestIdentity,
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
  speechRuntime?: ServerSpeechRuntime;
}, ledger: ResourceLedger, sharedMedia?: MediaRuntime): Promise<AppHandle> {
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
  const speechRuntime = opts.speechRuntime ?? createServerSpeechRuntime({
    speech: opts.speech, executorInjected: Boolean(opts.executor), env, now: opts.now,
  });
  const { page, projectPathJs, editReservationUiJs, pageCss, pageJs } = await loadAssemblyPageAssets();
  let boundPort = opts.port ?? 7788;
  const allowPaidModel = opts.allowPaidModel === true;
  const allowPaidVisual = opts.allowPaidVisual === true;
  const ownsMedia = !sharedMedia;
  const media = sharedMedia ?? await configuredMediaRuntime(opts.env, opts.now);
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
    editReservationUiJs,
    pageCss,
    pageJs,
    media,
    teamMode,
    templatesRoot,
    port: () => boundPort,
    allowPaidModel,
    allowPaidVisual,
    speechRuntime,
  });
  const { runtime, project, loadStored, transports, speech, closeSpeech } = setup;
  const templates=createTemplateRuntime(templatesRoot,{
    getMedia: media ? id => media.getMedia(id) : undefined,
    port:()=>boundPort,originConfig:network,selectFn:opts.selectFn,exec,speech,
    send:transports.textSend,visualClient:transports.visualClient,
    modelKey:transports.textKey,legacyModelKey:transports.legacyModelKey,legacyVisualCompatible:transports.legacyVisualCompatible,
    resolveAnalysis:transports.resolveAnalysis,
    allowModel:allowPaidModel,allowVisual:allowPaidVisual,
  });
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      await speechRuntime.sweep();
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

  const reconciliationAbort = new AbortController();
  const reconciliation = ledger.reconcile({ signal: reconciliationAbort.signal }).catch(error => {
    if (reconciliationAbort.signal.aborted && error === reconciliationAbort.signal.reason) ledger.cancelPendingReconciliation();
    else ledger.markIncomplete(error);
  });
  return {
    port, address: network.bindHost, jobId: project.id,
    close: async () => {
      reconciliationAbort.abort();
      // Tudo é iniciado antes do primeiro await: no `exit` só o trecho
      // síncrono roda, e é nele que os filhos e o worker de fala morrem.
      const killed = exec instanceof SpawnExecutor ? exec.terminateAll() : Promise.resolve();
      const runtimeClosed = runtime.close();
      const mediaClosed = ownsMedia ? (media?.close() ?? Promise.resolve()) : Promise.resolve();
      const authClosed = auth.close();
      const speechClosed = closeSpeech();
      const serverSpeechClosed = speechRuntime.close();
      const closed = new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      await Promise.all([killed, runtimeClosed, mediaClosed, authClosed, speechClosed, serverSpeechClosed, closed, reconciliation]);
    },
    killChildren: () => {
      if (exec instanceof SpawnExecutor) exec.killNow();
      speechRuntime.killChildren();
    },
  };
}
