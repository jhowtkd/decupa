import { createSpaceManager, withCapacityLock as sharedCapacityLock } from "./space.ts";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir, open, readdir, readFile, rename, rm, stat, writeFile,
  type FileHandle,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { probe } from "@decupa/media";
import { createR2Staging, type R2Staging, type StagingPart } from "./r2-staging.ts";
import { createDriveImport, DriveHttpError, parseDriveFileId, parseDriveUrl, type DriveImport } from "./drive-import.ts";

/** Estados que a interface do navegador usa para acompanhar um envio. */
export type UploadClientState = "uploading" | "paused" | "importing" | "verifying" | "ready" | "deduped" | "failed";

/** Snippet do protótipo: pausar retoma o mesmo envio, não cria outro. */
export const UPLOAD_STATE_FLOW = "uploading ⇄ paused → verifying → ready | deduped | failed";

const JSON_LIMIT = 1024 * 1024;
const DEFAULT_MAX_GB = 20;
const DEFAULT_PART_BYTES = 20 * 1024 * 1024;
const DEFAULT_TTL_HOURS = 24;

type ImportStage = "download" | "validation";
interface ImportQueueState {
  etapa: ImportStage;
  estado: "waiting" | "running";
  posicao: number;
}

/**
 * O deployment tem um único processo serve por raiz; não é um lock entre
 * processos. Runtimes do mesmo PID compartilham a admissão do acervo.
 */

interface ImportJob {
  task: Promise<void>;
  controller: AbortController;
  result?: Promise<{ mediaId: string; deduplicado: boolean }>;
}

interface RootAdmission {
  users: number;
  queues: Record<ImportStage, ReturnType<typeof stageQueue>>;
  locks: Map<string, Promise<unknown>>;
  jobs: Map<string, ImportJob>;
}

// Duas instâncias no mesmo PID herdam cotas, locks e workers já vivos. Só a
// primeira após o último close reconcilia reservas persistidas de uma queda.
const rootAdmissions = new Map<string, RootAdmission>();

function stageQueue(limit: number) {
  let active = 0;
  const waiting: { id: string; start: () => void }[] = [];
  function pump(): void {
    while (active < limit && waiting.length) waiting.shift()!.start();
  }
  return {
    position: (id: string) => waiting.findIndex(item => item.id === id) + 1,
    acquire(id: string, signal: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const item = { id, start: () => {
          signal.removeEventListener("abort", abort);
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            pump();
          });
        } };
        const abort = () => {
          const index = waiting.indexOf(item);
          if (index !== -1) waiting.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item);
        pump();
      });
    },
  };
}

interface R2Session {
  key: string;
  upload: string;
  partBytes: number;
  phase: "uploading" | "importing" | "failed" | "canceling";
  error?: string;
  status?: number;
}

interface DriveSession {
  fileId: string;
  md5?: string;
  phase: "downloading" | "failed" | "canceling";
  error?: string;
  status?: number;
}

interface UploadState {
  nome: string;
  tamanhoTotal: number;
  recebido: number;
  criadoEm: number;
  atualizadoEm: number;
  sha256?: string;
  r2?: R2Session;
  drive?: DriveSession;
  /** Compromisso de espaço futuro; os bytes já escritos pertencem ao statfs. */
  reserva?: boolean;
  fila?: ImportQueueState;
}

type CompletedUpload = { mediaId: string; deduplicado: boolean; expiraEm: number; r2?: R2Session };

export interface MediaMetadata {
  id: string;
  nome: string;
  tamanho: number;
  duracao: number;
  criadoEm: number;
}

export type MediaRecord = MediaMetadata & { path: string };

function validMetadata(value: unknown, id: string): value is MediaMetadata {
  if (typeof value !== "object" || value === null) return false;
  const metadata = value as Partial<MediaMetadata>;
  const tamanho = metadata.tamanho;
  return metadata.id === id
    && typeof metadata.nome === "string"
    && typeof tamanho === "number" && Number.isSafeInteger(tamanho) && tamanho >= 0
    && typeof metadata.duracao === "number" && Number.isFinite(metadata.duracao) && metadata.duracao >= 0
    && typeof metadata.criadoEm === "number" && Number.isFinite(metadata.criadoEm);
}

class UploadHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > JSON_LIMIT) throw new UploadHttpError(413, "body grande demais");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new UploadHttpError(400, "body inválido");
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new UploadHttpError(400, "body inválido"); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new UploadHttpError(400, "body inválido");
  }
  return body as Record<string, unknown>;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function integer(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UploadHttpError(400, message);
  }
  return value;
}

function uploadName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 255 || /[\\/\0]/.test(value)) {
    throw new UploadHttpError(400, "nome de mídia inválido");
  }
  return value;
}

function optionalSha(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new UploadHttpError(400, "sha256 inválido");
  }
  return value.toLowerCase();
}

function uploadId(value: string): boolean {
  return /^[0-9a-f-]{36}$/.test(value);
}

/** O nome vem do Drive: higieniza em vez de recusar, para não travar a importação. */
function sanitizeDriveName(value: string): string {
  // oxlint-disable-next-line no-control-regex -- higieniza nome do Drive: controles e DEL não entram no acervo.
  const clean = value.replace(/[\\/]/g, " ").replace(/[\0-\x1F\x7F]/g, "").trim().slice(0, 255);
  return clean === "" ? "drive-import" : clean;
}

function parseRange(value: string | undefined): { start: number; end: number; total: number } {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(value ?? "");
  if (!match) throw new UploadHttpError(400, "Content-Range inválido");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) {
    throw new UploadHttpError(400, "Content-Range inválido");
  }
  return { start, end, total };
}

async function hashPartial(path: string): Promise<Hash> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash;
}

export interface MediaRuntime {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  getMedia(mediaId: string): Promise<MediaRecord | null>;
  close(): Promise<void>;
  /** Verdadeiro quando há chave do Drive: a interface mostra a importação. */
  driveEnabled: boolean;
}

export interface MediaRuntimeOptions {
  root: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (message: string, error: unknown) => void;
  cleanupIntervalMs?: number;
  /** Gancho dos testes para segurar a janela entre publicar e limpar. */
  beforeRemoveUpload?: () => Promise<void>;
  staging?: R2Staging;
  drive?: DriveImport;
}

/** FileHandle.write pode aceitar menos bytes do que o buffer pede. */
export async function writeBufferFully(
  file: { write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }> },
  buffer: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await file.write(buffer, written, buffer.byteLength - written, position + written);
    if (result.bytesWritten <= 0) throw new Error("não foi possível escrever a parte inteira");
    written += result.bytesWritten;
  }
}

/**
 * Acervo e envios ficam num runtime próprio para que sejam globais: não há
 * Reserva de Edição nem estado de Projeto envolvido no envio de uma Mídia.
 */
export async function createMediaRuntime(opts: MediaRuntimeOptions): Promise<MediaRuntime> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((message, error) => console.error(message, error));
  const staging = opts.staging ?? createR2Staging(env);
  const drive = opts.drive ?? createDriveImport(env);
  const root = resolve(opts.root);
  const space = createSpaceManager(root);
  const pool = join(root, "pool");
  const temporary = join(root, ".tmp");
  const completed = join(root, ".completed");
  const maxBytes = positiveNumber(env.DECUPA_UPLOAD_MAX_GB, DEFAULT_MAX_GB) * 1024 ** 3;
  const partBytes = Math.floor(positiveNumber(
    env.DECUPA_UPLOAD_PART_BYTES,
    positiveNumber(env.DECUPA_UPLOAD_PART_MB, DEFAULT_PART_BYTES / (1024 * 1024)) * 1024 * 1024,
  ));
  const ttlMs = nonNegativeNumber(env.DECUPA_UPLOAD_TTL_HOURS, DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
  await mkdir(pool, { recursive: true });
  await mkdir(temporary, { recursive: true });
  await mkdir(completed, { recursive: true });

  let admission = rootAdmissions.get(root);
  if (!admission) {
    admission = {
      users: 0,
      queues: {
        download: stageQueue(Math.max(1, Math.floor(positiveNumber(env.DECUPA_UPLOAD_DOWNLOAD_CONCURRENCY, 1)))),
        validation: stageQueue(Math.max(1, Math.floor(positiveNumber(env.DECUPA_UPLOAD_VALIDATION_CONCURRENCY, 1)))),
      },
      locks: new Map(), jobs: new Map(),
    };
    rootAdmissions.set(root, admission);
  }
  const shared = admission;
  const { queues, locks } = shared;
  // O hash em memória só vale para os bytes que ele próprio viu. Outro
  // processo (ou outro runtime) pode ter gravado partes no mesmo envio:
  // o tamanho do parcial bate com o estado, mas o hash ficou para trás.
  const hashes = new Map<string, { hash: Hash; bytes: number }>();
  const imports = new Map<string, ImportJob>();
  const shutdown = new AbortController();
  let closing = false;
  let cleanupTask: Promise<void> | undefined;
  let cleanupRequested = false;

  function trackImport(id: string, job: ImportJob): void {
    imports.set(id, job);
    shared.jobs.set(id, job);
    const done = () => {
      if (imports.get(id) === job) imports.delete(id);
      if (shared.jobs.get(id) === job) shared.jobs.delete(id);
    };
    void job.task.then(done, done);
  }

  async function writeState(id: string, state: UploadState): Promise<void> {
    const path = join(temporary, id, "state.json");
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(state)}\n`, "utf8");
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async function readState(id: string): Promise<UploadState> {
    if (!uploadId(id)) throw new UploadHttpError(404, "envio não encontrado");
    try {
      const state = JSON.parse(await readFile(join(temporary, id, "state.json"), "utf8")) as UploadState;
      if (typeof state.nome !== "string" || !Number.isSafeInteger(state.tamanhoTotal) || state.tamanhoTotal <= 0
        || !Number.isSafeInteger(state.recebido) || state.recebido < 0 || state.recebido > state.tamanhoTotal) {
        throw new Error("estado inválido");
      }
      return state;
    } catch {
      throw new UploadHttpError(404, "envio não encontrado");
    }
  }

  function partialPath(id: string): string { return join(temporary, id, "data"); }

  async function withUploadLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    locks.set(id, current);
    try { return await current; }
    finally { if (locks.get(id) === current) locks.delete(id); }
  }

  async function withHashLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(`hash:${id}`) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    locks.set(`hash:${id}`, current);
    try { return await current; }
    finally { if (locks.get(`hash:${id}`) === current) locks.delete(`hash:${id}`); }
  }

  const withCapacityLock = sharedCapacityLock;

  async function assertCapacity(id: string, candidate: UploadState): Promise<void> {
    try { await space.assertUpload(id, candidate.tamanhoTotal); }
    catch { throw new UploadHttpError(507, "não há espaço suficiente no volume de Mídias"); }
  }

  async function reserve(id: string): Promise<void> {
    await withCapacityLock(async () => {
      const state = await readState(id);
      await assertCapacity(id, state);
      state.reserva = true;
      await writeState(id, state);
    });
  }

  /** Chamado sob o lock do envio; o callback termina antes de agendar o worker. */
  async function withNewReservation<T>(id: string, state: UploadState, fn: () => Promise<T>): Promise<T> {
    const alreadyReserved = state.reserva === true;
    await reserve(id);
    state.reserva = true;
    try { return await fn(); }
    catch (error) {
      // Falha de HEAD/Complete/sign ou de persistência antes de iniciar o
      // worker não transforma um retry falho em uma reserva órfã permanente.
      if (!alreadyReserved) {
        const current = await readState(id).catch(() => null);
        if (current) { current.reserva = false; await writeState(id, current); }
      }
      throw error;
    }
  }

  async function resetPartial(id: string, received: number, signal: AbortSignal, remove = false): Promise<void> {
    await withUploadLock(id, () => withCapacityLock(async () => {
      signal.throwIfAborted();
      const state = await readState(id);
      // Encolher um parcial aumenta bavail E a obrigação futura. A mesma
      // exclusão mútua da admissão impede misturar o tamanho antigo com o
      // espaço livre depois do truncate (inclusive quando Drive ignora Range).
      if (remove) await rm(partialPath(id), { force: true });
      else {
        const file = await open(partialPath(id), "a");
        try { await file.truncate(received); } finally { await file.close(); }
      }
      state.recebido = received;
      await assertCapacity(id, state);
      state.reserva = true;
      await writeState(id, state);
    }));
  }

  async function waitForReservation(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      try { await withUploadLock(id, () => reserve(id)); return; }
      catch (error) { if (!(error instanceof UploadHttpError) || error.status !== 507) throw error; }
      // O envio continua persistido e visível em espera quando outro consumidor
      // ocupou o disco durante a parada. Cancelamento/close não deixam timers.
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, 1000);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }

  function queueStatus(id: string, state: UploadState): ImportQueueState | undefined {
    if (!state.fila) return undefined;
    const position = queues[state.fila.etapa].position(id);
    return { ...state.fila, posicao: position || state.fila.posicao };
  }

  async function enterStage(id: string, etapa: ImportStage, signal: AbortSignal): Promise<() => void> {
    await withUploadLock(id, async () => {
      signal.throwIfAborted();
      const state = await readState(id);
      state.fila = { etapa, estado: "waiting", posicao: 1 };
      await writeState(id, state);
    });
    for (;;) {
      // A espera por disco fica fora das cotas: um envio antigo grande demais
      // não pode impedir outro já admitido de baixar/validar e liberar espaço.
      await waitForReservation(id, signal);
      const release = await queues[etapa].acquire(id, signal);
      try {
        await withUploadLock(id, async () => {
          signal.throwIfAborted();
          // O disco pode ter mudado enquanto esperávamos pela cota. Ao perder
          // capacidade, devolva o slot antes de esperar pela próxima tentativa.
          await reserve(id);
          const state = await readState(id);
          state.fila = { etapa, estado: "running", posicao: 0 };
          await writeState(id, state);
        });
        return release;
      } catch (error) {
        release();
        if (!(error instanceof UploadHttpError) || error.status !== 507) throw error;
      }
    }
  }

  async function validate(id: string, hash?: Hash, signal = shutdown.signal): Promise<{ mediaId: string; deduplicado: boolean }> {
    const release = await enterStage(id, "validation", signal);
    try {
      const input = await withUploadLock(id, async () => {
        signal.throwIfAborted();
        const receipt = await readCompletion(id);
        if (receipt) return { receipt };
        const state = await readState(id);
        return { state, hash: hash ?? await ensureHash(id, state) };
      });
      if (input.receipt) return { mediaId: input.receipt.mediaId, deduplicado: input.receipt.deduplicado };
      return await publish(id, input.state!, input.hash!, signal);
    } finally { release(); }
  }

  async function removeUpload(id: string): Promise<void> {
    hashes.delete(id);
    await rm(join(temporary, id), { recursive: true, force: true });
  }

  async function createUpload(id: string, state: UploadState, useStaging = false): Promise<void> {
    await withCapacityLock(async () => {
      await assertCapacity(id, state);
      try {
        await mkdir(join(temporary, id));
        await writeFile(partialPath(id), Buffer.alloc(0));
        if (useStaging && staging) {
          const key = `decupa-staging/${id}`;
          const size = Math.max(5 * 1024 * 1024, partBytes, Math.ceil(state.tamanhoTotal / 10_000));
          state.r2 = { key, upload: await staging.create(key), partBytes: size, phase: "uploading" };
        }
        state.reserva = true;
        await writeState(id, state);
      } catch (error) {
        if (state.r2) await staging!.abort(state.r2.key, state.r2.upload).catch(() => {});
        await removeUpload(id);
        throw error;
      }
    });
  }

  async function rememberCompletion(id: string, result: { mediaId: string; deduplicado: boolean }, r2?: R2Session): Promise<void> {
    const path = join(completed, `${id}.json`);
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify({ ...result, expiraEm: now() + ttlMs, r2 })}\n`, "utf8");
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async function readCompletion(id: string): Promise<CompletedUpload | null> {
    try {
      const value = JSON.parse(await readFile(join(completed, `${id}.json`), "utf8")) as CompletedUpload;
      if (!value.mediaId || (!value.r2 && value.expiraEm < now())) {
        await rm(join(completed, `${id}.json`), { force: true });
        return null;
      }
      // O registro pode ter sido escrito imediatamente antes do rename. Até o
      // arquivo aparecer, ele ainda precisa ser recuperado pelo parcial.
      if (!await stat(join(pool, value.mediaId)).then(() => true, () => false)) return null;
      return value;
    } catch {
      return null;
    }
  }

  async function ensureHash(id: string, state: UploadState): Promise<Hash> {
    const known = hashes.get(id);
    const path = partialPath(id);
    const file = await stat(path).catch(() => null);
    if (known && known.bytes === state.recebido && file?.size === state.recebido) return known.hash;
    if (known) hashes.delete(id);
    if (!file || file.size !== state.recebido) {
      await withCapacityLock(async () => {
        const handle = await open(path, "a");
        try { await handle.truncate(state.recebido); } finally { await handle.close(); }
      });
    }
    const hash = await hashPartial(path);
    hashes.set(id, { hash, bytes: state.recebido });
    return hash;
  }

  async function writeMetadata(mediaId: string, metadata: MediaMetadata): Promise<void> {
    const path = join(pool, `${mediaId}.json`);
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, `${JSON.stringify(metadata)}\n`, "utf8");
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async function publish(id: string, state: UploadState, hash: Hash, signal: AbortSignal): Promise<{ mediaId: string; deduplicado: boolean }> {
    signal.throwIfAborted();
    const mediaId = hash.digest("hex");
    // `digest` encerra o hash: uma nova tentativa depois de uma falha abaixo
    // precisa recalculá-lo a partir do parcial, não reaproveitar este.
    hashes.delete(id);
    if (state.sha256 && state.sha256 !== mediaId) {
      if (!state.r2 && !state.drive) await removeUpload(id);
      throw new UploadHttpError(422, "sha256 da mídia não confere");
    }
    const source = partialPath(id);
    let info;
    try { info = await probe(source); }
    catch (error) {
      if (!state.r2 && !state.drive) await removeUpload(id);
      throw new UploadHttpError(422, error instanceof Error ? error.message : "mídia ilegível");
    }
    if ((!info.hasVideo && !info.hasAudio) || info.durationMs <= 0) {
      if (!state.r2 && !state.drive) await removeUpload(id);
      throw new UploadHttpError(422, "mídia sem vídeo ou áudio legível");
    }

    // ffprobe fica fora do lock. Cancelar/consultar um envio em validação não
    // aguarda o subprocesso; o sinal e o estado são rechequados na publicação.
    return withUploadLock(id, async () => {
      signal.throwIfAborted();
      const current = await readState(id);
      if (current.r2?.phase === "canceling" || current.drive?.phase === "canceling") {
        throw new UploadHttpError(410, "envio cancelado");
      }
      return withHashLock(mediaId, async () => {
        const destination = join(pool, mediaId);
        const exists = await stat(destination).then(() => true, () => false);
        const metadata: MediaMetadata = {
          id: mediaId, nome: state.nome, tamanho: state.tamanhoTotal,
          duracao: info.durationMs / 1000, criadoEm: now(),
        };
        if (exists) {
          try {
            const current = JSON.parse(await readFile(join(pool, `${mediaId}.json`), "utf8"));
            if (!validMetadata(current, mediaId)) throw new Error("metadado inválido");
          } catch {
            // A publicação do arquivo é a fonte deduplicada; o metadado pode ser
            // reconstruído com a informação da tentativa que chegou agora.
            await writeMetadata(mediaId, metadata);
          }
          const result = { mediaId, deduplicado: true };
          await rememberCompletion(id, result, state.r2);
          await opts.beforeRemoveUpload?.();
          await removeUpload(id);
          return result;
        }
        // O arquivo só fica visível no acervo depois que o metadado também está
        // pronto; assim uma falha não deixa uma Mídia deduplicável sem registro.
        await writeMetadata(mediaId, metadata);
        const result = { mediaId, deduplicado: false };
        await rememberCompletion(id, result, state.r2);
        await rename(source, destination);
        await opts.beforeRemoveUpload?.();
        await removeUpload(id);
        return result;
      });
    });
  }

  function startLocalValidation(id: string): Promise<{ mediaId: string; deduplicado: boolean }> {
    const known = shared.jobs.get(id)?.result;
    if (known) return known;
    const controller = new AbortController();
    if (closing) controller.abort();
    const result = validate(id, undefined, controller.signal).catch(async error => {
      await withUploadLock(id, async () => {
        const state = await readState(id).catch(() => null);
        if (!state || closing) return;
        state.reserva = false;
        delete state.fila;
        await writeState(id, state);
      });
      throw error;
    });
    const task = result.then(() => {}, () => {});
    trackImport(id, { task, controller, result });
    return result;
  }

  async function patch(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let finish = false;
    await withUploadLock(id, async () => {
      const completedUpload = await readCompletion(id);
      if (completedUpload) {
        for await (const _chunk of req) { /* drena uma repetição depois da resposta perdida */ }
        sendJson(res, { mediaId: completedUpload.mediaId, deduplicado: completedUpload.deduplicado }, 201);
        return;
      }
      const state = await readState(id);
      if (state.r2) throw new UploadHttpError(409, "este envio usa R2");
      if (state.drive) throw new UploadHttpError(409, "este envio usa o Drive");
      const range = parseRange(typeof req.headers["content-range"] === "string" ? req.headers["content-range"] : undefined);
      const length = range.end - range.start + 1;
      if (range.total !== state.tamanhoTotal) throw new UploadHttpError(409, "tamanho total não confere");
      if (length > partBytes) throw new UploadHttpError(413, "parte do envio grande demais");
      if (range.end < state.recebido) {
        for await (const _chunk of req) { /* drena o reenvio sem segurá-lo na memória */ }
        if (state.recebido === state.tamanhoTotal) {
          finish = true;
        } else {
          sendJson(res, { offset: state.recebido });
        }
        return;
      }
      if (range.start !== state.recebido) {
        for await (const _chunk of req) { /* libera a conexão antes de responder o conflito */ }
        sendJson(res, { offset: state.recebido }, 409);
        return;
      }

      await reserve(id);
      state.reserva = true;

      const hash = await ensureHash(id, state);
      const file = await open(partialPath(id), "r+");
      let received = 0;
      try {
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk as Uint8Array);
          received += buffer.byteLength;
          if (received > length) throw new UploadHttpError(413, "parte do envio maior que Content-Range");
          await writeBufferFully(file, buffer, range.start + received - buffer.byteLength);
          hash.update(buffer);
          const cached = hashes.get(id);
          if (cached?.hash === hash) cached.bytes += buffer.byteLength;
        }
        if (received !== length) throw new UploadHttpError(400, "corpo menor que Content-Range");
      } catch (error) {
        await withCapacityLock(() => file.truncate(state.recebido));
        hashes.delete(id);
        throw error;
      } finally {
        await file.close();
      }

      const next: UploadState = { ...state, recebido: range.end + 1, atualizadoEm: now() };
      if (next.recebido === next.tamanhoTotal) next.fila = { etapa: "validation", estado: "waiting", posicao: 1 };
      try {
        await writeState(id, next);
      } catch (error) {
        // O parcial já foi escrito, mas o estado ainda aponta para o offset
        // anterior. Não deixe o hash em memória representar bytes invisíveis.
        hashes.delete(id);
        const rollback = await open(partialPath(id), "r+").catch(() => null);
        if (rollback) {
          try { await withCapacityLock(() => rollback.truncate(state.recebido)); } finally { await rollback.close(); }
        }
        throw error;
      }
      if (next.recebido === next.tamanhoTotal) {
        finish = true;
      } else {
        sendJson(res, { offset: next.recebido });
      }
    });
    // A espera pela cota de validação não segura o lock do envio: GET e DELETE
    // continuam atendendo enquanto o parcial completo aguarda publicação.
    if (finish) sendJson(res, await startLocalValidation(id), 201);
  }

  async function listMedia(): Promise<MediaMetadata[]> {
    const entries = await readdir(pool, { withFileTypes: true });
    const result: MediaMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(await readFile(join(pool, entry.name), "utf8")) as MediaMetadata;
        if (typeof metadata.id === "string" && await stat(join(pool, metadata.id)).then(() => true, () => false)) result.push(metadata);
      } catch { /* uma entrada incompleta não torna o acervo inteiro indisponível */ }
    }
    return result.sort((a, b) => a.nome.localeCompare(b.nome));
  }

  async function getMedia(mediaId: string): Promise<MediaRecord | null> {
    if (!/^[0-9a-f]{64}$/i.test(mediaId)) return null;
    const id = mediaId.toLowerCase();
    try {
      const metadata = JSON.parse(await readFile(join(pool, `${id}.json`), "utf8")) as MediaMetadata;
      if (metadata.id !== id || !await stat(join(pool, id)).then(() => true, () => false)) return null;
      return { ...metadata, path: join(pool, id) };
    } catch {
      return null;
    }
  }

  function requireStaging(): R2Staging {
    if (!staging) throw new UploadHttpError(503, "configure R2 para retomar este envio");
    return staging;
  }

  function requireDrive(): DriveImport {
    if (!drive) throw new UploadHttpError(503, "importação do Drive não configurada");
    return drive;
  }

  // Persistência do progresso do Drive: o lock é breve, só para gravar o
  // offset. Um DELETE no meio da escrita interrompe o download sem travar.
  const DRIVE_PROGRESS_BYTES = 1024 * 1024;
  const DRIVE_INTERRUPTED = new Error("importação do Drive interrompida");

  async function syncPath(path: string): Promise<void> {
    const file = await open(path, "r");
    try { await file.sync(); } finally { await file.close(); }
  }

  // O recibo precede o rename e sobrevive à pasta temporária. Nunca expire um
  // recibo com exclusão pendente; uma indisponibilidade do R2 pode durar dias.
  async function cleanRemote(id: string, receipt: CompletedUpload): Promise<void> {
    if (!receipt.r2 || !staging) return;
    const media = await getMedia(receipt.mediaId);
    if (!media || (await stat(media.path)).size !== media.tamanho) return;
    try {
      await syncPath(media.path);
      await syncPath(join(pool, `${receipt.mediaId}.json`));
      await syncPath(pool);
      await syncPath(join(completed, `${id}.json`));
      await syncPath(completed);
      await staging.delete(receipt.r2.key);
      await rememberCompletion(id, receipt);
    } catch {
      log(`limpeza R2 pendente para o envio ${id}`, new Error("a cópia local está disponível; a exclusão será repetida"));
    }
  }

  function startImport(id: string): void {
    if (closing || shared.jobs.has(id)) return;
    const controller = new AbortController();
    const { signal } = controller;
    let releaseDownload: (() => void) | undefined;
    const task = (async () => {
      try {
        const state = await withUploadLock(id, async () => {
          if (await readCompletion(id)) { await removeUpload(id); runCleanup(); return null; }
          return readState(id);
        });
        if (!state?.r2 || state.r2.phase !== "importing" || signal.aborted) return;
        if (state.recebido === state.tamanhoTotal
          && await stat(partialPath(id)).then(file => file.size === state.tamanhoTotal, () => false)) {
          await validate(id, undefined, signal);
          runCleanup();
          return;
        }
        releaseDownload = await enterStage(id, "download", signal);
        const remote = requireStaging();
        const object = await remote.head(state.r2.key);
        signal.throwIfAborted();
        if (!object || object.size !== state.tamanhoTotal) throw new UploadHttpError(422, "tamanho do objeto R2 não confere");
        // A importação recomeça do objeto íntegro. Recolha o parcial de uma
        // tentativa anterior antes de conferir espaço para a nova cópia.
        await resetPartial(id, 0, signal, true);
        const file = await open(partialPath(id), "w");
        const hash = createHash("sha256");
        let received = 0;
        try {
          for await (const chunk of remote.read(state.r2.key, object.etag, signal)) {
            signal.throwIfAborted();
            if (received + chunk.byteLength > state.tamanhoTotal) throw new UploadHttpError(422, "tamanho da importação não confere");
            await writeBufferFully(file, chunk, received);
            hash.update(chunk);
            received += chunk.byteLength;
          }
          if (received !== state.tamanhoTotal) throw new UploadHttpError(422, "importação incompleta");
          await file.sync();
        } finally { await file.close(); }
        // Só a publicação ocupa o lock. Um DELETE pode persistir canceling e
        // abortar o stream enquanto o download ainda está em andamento.
        await withUploadLock(id, async () => {
          const current = await readState(id).catch(() => null);
          if (signal.aborted || current?.r2?.phase !== "importing") return;
          current.recebido = received;
          current.atualizadoEm = now();
          current.fila = { etapa: "validation", estado: "waiting", posicao: 1 };
          await writeState(id, current);
        });
        releaseDownload();
        releaseDownload = undefined;
        if (!signal.aborted) await validate(id, hash, signal);
        runCleanup();
      } catch (error) {
        await withUploadLock(id, async () => {
          // Se a queda ocorreu depois de publicar, o recibo é a fonte de verdade.
          if (await readCompletion(id)) { runCleanup(); await removeUpload(id); return; }
          if (closing || signal.aborted) return;
          await rm(partialPath(id), { force: true });
          const current = await readState(id).catch(() => null);
          if (!current?.r2 || current.r2.phase === "canceling") return;
          current.r2.phase = "failed";
          current.r2.status = error instanceof UploadHttpError ? error.status : 502;
          current.r2.error = error instanceof UploadHttpError ? error.message : "não foi possível importar do R2; tente novamente";
          current.recebido = 0;
          current.reserva = false;
          delete current.fila;
          current.atualizadoEm = now();
          await writeState(id, current);
        });
      } finally { releaseDownload?.(); }
    })().catch(() => log(`falha na importação R2 ${id}`, new Error("o envio pode ser retomado")));
    trackImport(id, { task, controller });
  }

  // Download do Drive com retomada por Range. Falha de rede preserva o
  // parcial e o offset; falha de integridade (422) descarta o parcial.
  // A conferência de espaço desconta o que já foi baixado.
  function startDriveImport(id: string): void {
    if (closing || shared.jobs.has(id)) return;
    const controller = new AbortController();
    const { signal } = controller;
    let received = 0;
    let file: FileHandle | null = null;
    let releaseDownload: (() => void) | undefined;
    const task = (async () => {
      try {
        const state = await withUploadLock(id, async () => {
          if (await readCompletion(id)) { await removeUpload(id); runCleanup(); return null; }
          return readState(id);
        });
        if (!state?.drive || state.drive.phase !== "downloading" || signal.aborted) return;
        received = state.recebido;
        if (state.fila?.etapa === "validation" && state.recebido === state.tamanhoTotal
          && await stat(partialPath(id)).then(file => file.size === state.tamanhoTotal, () => false)) {
          await validate(id, undefined, signal);
          runCleanup();
          return;
        }
        releaseDownload = await enterStage(id, "download", signal);
        const remote = requireDrive();
        const total = state.tamanhoTotal;
        const expectedMd5 = state.drive.md5;
        received = state.recebido;
        const existing = await stat(partialPath(id)).catch(() => null);
        if (!existing || existing.size < received) received = 0;
        if (received === 0 || existing!.size > received) await resetPartial(id, received, signal);
        file = await open(partialPath(id), "r+");
        let sha = createHash("sha256");
        let md5 = createHash("md5");
        if (received > 0) {
          for await (const chunk of createReadStream(partialPath(id))) {
            sha.update(chunk as Buffer);
            md5.update(chunk as Buffer);
          }
        }
        await withUploadLock(id, () => reserve(id));
        const stream = await remote.read(state.drive.fileId, received, total, signal);
        signal.throwIfAborted();
        if (stream.restarted) {
          received = 0;
          sha = createHash("sha256");
          md5 = createHash("md5");
          await resetPartial(id, 0, signal);
        }
        let lastPersisted = received;
        for await (const chunk of stream.body) {
          signal.throwIfAborted();
          const buffer = Buffer.from(chunk as Uint8Array);
          if (received + buffer.byteLength > total) throw new UploadHttpError(422, "tamanho da importação não confere");
          await writeBufferFully(file, buffer, received);
          sha.update(buffer);
          md5.update(buffer);
          received += buffer.byteLength;
          if (received - lastPersisted >= DRIVE_PROGRESS_BYTES) {
            lastPersisted = received;
            await withUploadLock(id, async () => {
              const current = await readState(id).catch(() => null);
              if (signal.aborted || current?.drive?.phase !== "downloading") throw DRIVE_INTERRUPTED;
              current.recebido = received;
              current.atualizadoEm = now();
              await writeState(id, current);
            });
          }
        }
        if (received !== total) throw new UploadHttpError(422, "importação incompleta");
        if (expectedMd5 && md5.digest("hex") !== expectedMd5) throw new UploadHttpError(422, "hash do Drive não confere");
        await file.sync();
        await file.close();
        file = null;
        // Só a publicação ocupa o lock. Um DELETE pode persistir canceling e
        // abortar o stream enquanto o download ainda está em andamento.
        await withUploadLock(id, async () => {
          const current = await readState(id).catch(() => null);
          if (signal.aborted || current?.drive?.phase !== "downloading") return;
          current.recebido = received;
          current.atualizadoEm = now();
          current.fila = { etapa: "validation", estado: "waiting", posicao: 1 };
          await writeState(id, current);
        });
        releaseDownload();
        releaseDownload = undefined;
        if (!signal.aborted) await validate(id, sha, signal);
        runCleanup();
      } catch (error) {
        if (file) await file.close().catch(() => {});
        file = null;
        if (error === DRIVE_INTERRUPTED) return;
        await withUploadLock(id, async () => {
          // Se a queda ocorreu depois de publicar, o recibo é a fonte de verdade.
          if (await readCompletion(id)) { runCleanup(); await removeUpload(id); return; }
          if (closing || signal.aborted) return;
          const current = await readState(id).catch(() => null);
          if (!current?.drive || current.drive.phase === "canceling") return;
          const fatal = (error instanceof UploadHttpError && error.status === 422)
            || (error instanceof DriveHttpError && error.status === 422);
          const status = error instanceof UploadHttpError || error instanceof DriveHttpError ? error.status : 502;
          const message = error instanceof UploadHttpError || error instanceof DriveHttpError ? error.message
            : "não foi possível importar do Drive; tente novamente";
          if (fatal) {
            await rm(partialPath(id), { force: true });
            current.recebido = 0;
          } else {
            current.recebido = received;
          }
          current.drive.phase = "failed";
          current.drive.status = status;
          current.drive.error = message;
          current.reserva = false;
          delete current.fila;
          current.atualizadoEm = now();
          await writeState(id, current);
        });
      } finally {
        if (file) await file.close().catch(() => {});
        releaseDownload?.();
      }
    })().catch(() => log(`falha na importação do Drive ${id}`, new Error("a importação pode ser retomada")));
    trackImport(id, { task, controller });
  }

  function checkedParts(state: UploadState, parts: StagingPart[]): StagingPart[] {
    const size = state.r2!.partBytes;
    const count = Math.ceil(state.tamanhoTotal / size);
    if (parts.length !== count || parts.some((part, index) => part.number !== index + 1
      || part.size !== Math.min(size, state.tamanhoTotal - index * size))) {
      throw new UploadHttpError(409, "partes do envio incompletas ou com tamanho incorreto");
    }
    return parts;
  }

  async function r2Status(id: string, state: UploadState): Promise<Record<string, unknown>> {
    const session = state.r2!;
    if (session.phase === "canceling") throw new UploadHttpError(410, "envio cancelado");
    if (session.phase === "importing") startImport(id);
    const result = { transporte: "r2", tamanhoTotal: state.tamanhoTotal, tamanhoParte: session.partBytes, fila: queueStatus(id, state) };
    if (session.phase === "failed") return { ...result, estado: "failed", error: session.error, status: session.status };
    if (session.phase === "importing") return { ...result, estado: "importing", offset: state.tamanhoTotal };
    const remote = requireStaging();
    // Também recupera a queda entre CompleteMultipartUpload e writeState.
    if (await remote.head(session.key)) {
      session.phase = "importing";
      state.atualizadoEm = now();
      await writeState(id, state);
      startImport(id);
      return { ...result, estado: "importing", offset: state.tamanhoTotal };
    }
    const parts = await remote.parts(session.key, session.upload);
    let offset = 0;
    for (const part of parts) {
      const expected = Math.min(session.partBytes, state.tamanhoTotal - offset);
      if (part.number !== offset / session.partBytes + 1 || part.size !== expected) break;
      offset += part.size;
    }
    state.atualizadoEm = now();
    await writeState(id, state);
    return { ...result, offset, estado: "uploading" };
  }

  async function driveStatus(id: string, state: UploadState): Promise<Record<string, unknown>> {
    const session = state.drive!;
    if (session.phase === "canceling") throw new UploadHttpError(410, "envio cancelado");
    const result = { transporte: "drive", tamanhoTotal: state.tamanhoTotal, nome: state.nome, fila: queueStatus(id, state) };
    if (session.phase === "failed") {
      return { ...result, estado: "failed", error: session.error, status: session.status, offset: state.recebido };
    }
    startDriveImport(id);
    return { ...result, estado: "importing", offset: state.recebido };
  }

  async function cancelRemote(id: string, session: R2Session): Promise<void> {
    const remote = requireStaging();
    await remote.abort(session.key, session.upload);
    await remote.delete(session.key);
    await removeUpload(id);
  }

  async function releaseCanceled(id: string): Promise<void> {
    const job = shared.jobs.get(id);
    job?.controller.abort();
    await job?.task;
    await withUploadLock(id, async () => {
      const current = await readState(id).catch(() => null);
      if (!current || (current.r2?.phase !== "canceling" && current.drive?.phase !== "canceling")) return;
      await rm(partialPath(id), { force: true });
      current.reserva = false;
      delete current.fila;
      await writeState(id, current);
    });
  }

  async function cleanExpired(localOnly = false): Promise<void> {
    const cutoff = now() - ttlMs;
    for (const entry of await readdir(temporary, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uploadId(entry.name)) continue;
      const state = await readFile(join(temporary, entry.name, "state.json"), "utf8")
        .then((raw) => JSON.parse(raw) as UploadState, () => null);
      // Drive não tem cópia remota para limpar: o cancelamento só remove o
      // parcial. Sem rede envolvida, vale também na limpeza de inicialização.
      if (state?.drive?.phase === "canceling") {
        await releaseCanceled(entry.name);
        await removeUpload(entry.name)
          .catch(() => log(`cancelamento do Drive pendente ${entry.name}`, new Error("a limpeza será repetida")));
        continue;
      }
      if ((state?.r2 || state?.drive) && localOnly) continue;
      if (state?.r2?.phase === "canceling" && staging) {
        await releaseCanceled(entry.name);
        await cancelRemote(entry.name, state.r2)
          .catch(() => log(`cancelamento R2 pendente ${entry.name}`, new Error("a exclusão será repetida")));
        continue;
      }
      // Reconciliar todos os objetos concluídos cobre a queda entre Complete
      // e writeState, mesmo que a aba nunca mais consulte o envio.
      if (state?.r2?.phase === "uploading" && staging) {
        try {
          const object = await staging.head(state.r2.key);
          if (object) {
            await withUploadLock(entry.name, async () => {
              const current = await readState(entry.name).catch(() => null);
              if (current?.r2?.phase !== "uploading") return;
              current.r2.phase = "importing";
              current.atualizadoEm = now();
              await writeState(entry.name, current);
              startImport(entry.name);
            });
            continue;
          }
        } catch {
          log(`reconciliação R2 pendente ${entry.name}`, new Error("a verificação será repetida"));
          continue;
        }
      }
      // Sob o lock do envio: uma parte chegando agora não pode ter a pasta
      // apagada no meio da escrita.
      if (state && state.atualizadoEm <= cutoff) {
        await withUploadLock(entry.name, async () => {
          const current = await readState(entry.name).catch(() => null);
          if (current && current.atualizadoEm <= cutoff) {
            if (current.drive) {
              // Falha aguarda retry explícito; download parado expira com o parcial.
              if (current.drive.phase !== "downloading") return;
              shared.jobs.get(entry.name)?.controller.abort();
              await removeUpload(entry.name);
              return;
            }
            if (current.r2) {
              if (current.r2.phase !== "uploading" || !staging) return;
              // Um objeto completo ainda não validado não deve ser apagado.
              if (await staging.head(current.r2.key)) {
                current.r2.phase = "importing";
                await writeState(entry.name, current);
                startImport(entry.name);
                return;
              }
              await staging.abort(current.r2.key, current.r2.upload);
            }
            await removeUpload(entry.name);
          }
        }).catch(() => log(`limpeza de envio pendente ${entry.name}`, new Error("a limpeza será repetida")));
      }
    }
  }

  async function cleanCompleted(): Promise<void> {
    for (const entry of await readdir(completed, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const item = await readFile(join(completed, entry.name), "utf8")
        .then((raw) => JSON.parse(raw) as CompletedUpload, () => null);
      if (!item) continue;
      if (item.r2) {
        const receipt = await readCompletion(entry.name.slice(0, -5));
        if (receipt) await cleanRemote(entry.name.slice(0, -5), receipt);
      } else if (item.expiraEm < now()) await withUploadLock(entry.name.slice(0, -5), async () => {
        const current = await readCompletion(entry.name.slice(0, -5));
        if (!current) await rm(join(completed, entry.name), { force: true });
      });
    }
  }

  function runCleanup(): void {
    if (closing) return;
    if (cleanupTask) { cleanupRequested = true; return; }
    cleanupRequested = false;
    cleanupTask = cleanExpired().then(cleanCompleted)
      .catch((error) => { if (!closing) log("falha na limpeza de envios", error); })
      .finally(() => { cleanupTask = undefined; if (cleanupRequested) runCleanup(); });
  }

  await cleanExpired(true);
  const recovered: [string, UploadState][] = [];
  // O estado persistido é o ledger. Nunca confie numa reserva/slot que ficou
  // marcado como ativo depois de uma queda: reconcilie antes de abrir streams.
  await withCapacityLock(async () => {
    const inherited = shared.users > 0;
    for (const entry of await readdir(temporary, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uploadId(entry.name)) continue;
      if (inherited && shared.jobs.has(entry.name)) continue;
      const state = await readState(entry.name).catch(() => null);
      if (!state) continue;
      if (!inherited) {
        if (await readCompletion(entry.name)) { await removeUpload(entry.name); continue; }
        state.reserva = false;
        if (state.fila) state.fila = { ...state.fila, estado: "waiting", posicao: 1 };
        await writeState(entry.name, state);
      }
      if (state.r2?.phase === "failed" || state.r2?.phase === "canceling"
        || state.drive?.phase === "failed" || state.drive?.phase === "canceling") continue;
      recovered.push([entry.name, state]);
    }
    recovered.sort((a, b) => a[1].criadoEm - b[1].criadoEm || a[0].localeCompare(b[0]));
    // Nunca exponha o ledger zerado a outra instância do mesmo PID. Uma raiz
    // já viva herda suas reservas e workers; só um boot sem owners reconcilia.
    if (!inherited) for (const [id, state] of recovered) {
      try {
        await assertCapacity(id, state);
        state.reserva = true;
        await writeState(id, state);
      } catch (error) { if (!(error instanceof UploadHttpError) || error.status !== 507) throw error; }
    }
    shared.users++;
  });
  for (const [id, state] of recovered) {
    if (state.r2?.phase === "importing") startImport(id);
    else if (state.drive?.phase === "downloading") startDriveImport(id);
    else if (!state.r2 && !state.drive && state.recebido === state.tamanhoTotal) {
      void startLocalValidation(id).catch(error => log(`validação local pendente ${id}`, error));
    }
  }
  runCleanup();
  const cleanupIntervalMs = opts.cleanupIntervalMs ?? Math.max(1_000, Math.min(60 * 60 * 1000, ttlMs / 2 || 1_000));
  const interval = setInterval(runCleanup, cleanupIntervalMs);
  interval.unref?.();

  const runtime: MediaRuntime = {
    getMedia,
    driveEnabled: drive !== undefined,
    handle: async (req, res): Promise<boolean> => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      try {
        if (url.pathname === "/api/media" && req.method === "GET") {
          sendJson(res, await listMedia());
          return true;
        }
        if (url.pathname === "/api/uploads" && req.method === "POST") {
          const body = await readJson(req);
          const nome = uploadName(body.nome);
          const tamanho = integer(body.tamanho, "tamanho inválido");
          if (tamanho === 0) throw new UploadHttpError(400, "tamanho inválido");
          const sha256 = optionalSha(body.sha256);
          if (sha256 && await stat(join(pool, sha256)).then(() => true, () => false)) {
            try {
              const current = JSON.parse(await readFile(join(pool, `${sha256}.json`), "utf8"));
              if (!validMetadata(current, sha256)) throw new Error("metadado inválido");
            } catch {
              const release = await queues.validation.acquire(`dedupe:${randomUUID()}`, shutdown.signal);
              try {
                const info = await probe(join(pool, sha256));
                const metadata: MediaMetadata = {
                  id: sha256, nome, tamanho: (await stat(join(pool, sha256))).size,
                  duracao: info.durationMs / 1000, criadoEm: now(),
                };
                await writeMetadata(sha256, metadata);
              } finally { release(); }
            }
            sendJson(res, { mediaId: sha256, deduplicado: true });
            return true;
          }
          if (tamanho > maxBytes) throw new UploadHttpError(413, "mídia acima do tamanho máximo");
          const id = randomUUID();
          const state: UploadState = { nome, tamanhoTotal: tamanho, recebido: 0, criadoEm: now(), atualizadoEm: now(), sha256 };
          await createUpload(id, state, true);
          const { r2 } = state;
          sendJson(res, { id, offset: 0, tamanhoParte: r2?.partBytes ?? partBytes, ...(r2 ? { transporte: "r2" } : {}) }, 201);
          return true;
        }
        if (url.pathname === "/api/uploads/from-drive" && req.method === "POST") {
          const remote = requireDrive();
          const body = await readJson(req);
          let fileId: string;
          let file: { nome: string; tamanho: number; md5?: string };
          try {
            fileId = parseDriveFileId(body.url);
            file = await remote.metadata(fileId);
          } catch (error) {
            if (error instanceof DriveHttpError) throw new UploadHttpError(error.status, error.message);
            throw new UploadHttpError(502, "não foi possível alcançar o Google Drive; tente novamente");
          }
          if (file.tamanho === 0) throw new UploadHttpError(400, "o arquivo do Drive está vazio");
          if (file.tamanho > maxBytes) throw new UploadHttpError(413, "mídia acima do tamanho máximo");
          const id = randomUUID();
          const nome = sanitizeDriveName(file.nome);
          await createUpload(id, {
            nome, tamanhoTotal: file.tamanho, recebido: 0, criadoEm: now(), atualizadoEm: now(),
            drive: { fileId, md5: file.md5, phase: "downloading" },
          });
          startDriveImport(id);
          sendJson(res, { id, transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: file.tamanho, nome }, 202);
          return true;
        }
        // Expansão de pasta: só lista, sem criar envios. A interface cria um
        // item por mídia, cada um com seu próprio envio retomável.
        if (url.pathname === "/api/uploads/from-drive/list" && req.method === "POST") {
          const remote = requireDrive();
          const body = await readJson(req);
          try {
            const parsed = parseDriveUrl(body.url);
            if (parsed.kind === "folder") {
              const { items, ignorados } = await remote.listMedia(parsed.id);
              if (items.length === 0) throw new UploadHttpError(400, "nenhum vídeo ou áudio na pasta do Drive");
              sendJson(res, {
                tipo: "pasta",
                items: items.map(item => ({ fileId: item.id, nome: item.nome, tamanho: item.tamanho })),
                ignorados,
              });
              return true;
            }
            try {
              const file = await remote.metadata(parsed.id);
              sendJson(res, { tipo: "arquivo", fileId: parsed.id, nome: file.nome, tamanho: file.tamanho });
            } catch (error) {
              // ID puro de pasta: metadados revelam, lista expande.
              if (error instanceof DriveHttpError && error.code === "FOLDER_ID") {
                const { items, ignorados } = await remote.listMedia(parsed.id);
                if (items.length === 0) throw new UploadHttpError(400, "nenhum vídeo ou áudio na pasta do Drive");
                sendJson(res, {
                  tipo: "pasta",
                  items: items.map(item => ({ fileId: item.id, nome: item.nome, tamanho: item.tamanho })),
                  ignorados,
                });
                return true;
              }
              throw error;
            }
          } catch (error) {
            if (error instanceof UploadHttpError) throw error;
            if (error instanceof DriveHttpError) throw new UploadHttpError(error.status, error.message);
            throw new UploadHttpError(502, "não foi possível alcançar o Google Drive; tente novamente");
          }
          return true;
        }
        if (parts[0] === "api" && parts[1] === "uploads" && parts[2] && uploadId(parts[2])) {
          const id = parts[2];
          if (parts.length === 4 && req.method === "POST" && parts[3] === "retry") {
            await withUploadLock(id, async () => {
              const receipt = await readCompletion(id);
              if (receipt) { sendJson(res, { mediaId: receipt.mediaId, deduplicado: receipt.deduplicado }); return; }
              const state = await readState(id);
              if (!state.drive) throw new UploadHttpError(409, "este envio não é do Drive");
              if (state.drive.phase === "canceling") throw new UploadHttpError(410, "envio cancelado");
              if (state.drive.phase === "downloading") {
                startDriveImport(id);
                sendJson(res, { transporte: "drive", estado: "importing" }, 202);
                return;
              }
              if (state.drive.status === 422) throw new UploadHttpError(409, "esta mídia falhou na validação; escolha outro arquivo");
              requireDrive();
              await withNewReservation(id, state, async () => {
                state.drive!.phase = "downloading";
                delete state.drive!.error;
                delete state.drive!.status;
                state.atualizadoEm = now();
                await writeState(id, state);
              });
              startDriveImport(id);
              sendJson(res, { transporte: "drive", estado: "importing" }, 202);
            });
            return true;
          }
          if (parts.length === 4 && req.method === "POST" && ["parts", "complete"].includes(parts[3]!)) {
            await withUploadLock(id, async () => {
              const receipt = await readCompletion(id);
              if (receipt) { sendJson(res, { mediaId: receipt.mediaId, deduplicado: receipt.deduplicado }); return; }
              const state = await readState(id);
              if (state.drive) throw new UploadHttpError(409, "este envio usa o Drive");
              const session = state.r2;
              if (!session) throw new UploadHttpError(409, "este envio não usa R2");
              if (session.phase === "canceling") throw new UploadHttpError(410, "envio cancelado");
              if (shared.jobs.has(id)) { sendJson(res, { transporte: "r2", estado: "importing" }, 202); return; }
              const remote = requireStaging();
              if (parts[3] === "parts") {
                if (session.phase !== "uploading") throw new UploadHttpError(409, "envio já finalizado");
                const body = await readJson(req);
                const numero = integer(body.numero, "número da parte inválido");
                if (numero < 1 || numero > Math.ceil(state.tamanhoTotal / session.partBytes)) throw new UploadHttpError(400, "número da parte inválido");
                const signed = await withNewReservation(id, state, async () => {
                  const signed = await remote.signPart(session.key, session.upload, numero);
                  state.atualizadoEm = now();
                  await writeState(id, state);
                  return signed;
                });
                sendJson(res, { url: signed });
              } else {
                // HEAD torna a conclusão repetível mesmo se a resposta do R2
                // se perdeu depois de ele concluir o multipart.
                await withNewReservation(id, state, async () => {
                  let object = await remote.head(session.key);
                  if (!object) {
                    const uploaded = checkedParts(state, await remote.parts(session.key, session.upload));
                    await remote.complete(session.key, session.upload, uploaded);
                    object = await remote.head(session.key);
                  }
                  if (!object || object.size !== state.tamanhoTotal) throw new UploadHttpError(422, "tamanho do objeto R2 não confere");
                  session.phase = "importing";
                  delete session.error;
                  delete session.status;
                  state.atualizadoEm = now();
                  await writeState(id, state);
                });
                startImport(id);
                sendJson(res, { transporte: "r2", estado: "importing" }, 202);
              }
            });
            return true;
          }
          if (parts.length !== 3) return false;
          if (req.method === "GET") {
            const initial = await readState(id).catch(() => null);
            if (initial && !initial.r2 && !initial.drive && initial.recebido === initial.tamanhoTotal) {
              const receipt = await readCompletion(id);
              if (receipt) {
                sendJson(res, { ...receipt, estado: receipt.deduplicado ? "deduped" : "ready" });
              } else if (shared.jobs.has(id)) {
                sendJson(res, { offset: initial.recebido, tamanhoTotal: initial.tamanhoTotal, estado: "verifying", fila: queueStatus(id, initial) });
              } else {
                const result = await startLocalValidation(id);
                sendJson(res, { ...result, offset: initial.recebido, tamanhoTotal: initial.tamanhoTotal, estado: result.deduplicado ? "deduped" : "ready" });
              }
              return true;
            }
            await withUploadLock(id, async () => {
              const completedUpload = await readCompletion(id);
              if (completedUpload) {
                sendJson(res, {
                  mediaId: completedUpload.mediaId, deduplicado: completedUpload.deduplicado,
                  estado: completedUpload.deduplicado ? "deduped" : "ready" satisfies UploadClientState,
                });
                return;
              }
              const state = await readState(id);
              if (state.r2) {
                sendJson(res, await r2Status(id, state));
              } else if (state.drive) {
                sendJson(res, await driveStatus(id, state));
              } else if (state.recebido === state.tamanhoTotal) {
                sendJson(res, { offset: state.recebido, tamanhoTotal: state.tamanhoTotal, estado: "verifying", fila: queueStatus(id, state) });
                void startLocalValidation(id).catch(error => log(`validação local pendente ${id}`, error));
              } else {
                sendJson(res, { offset: state.recebido, tamanhoTotal: state.tamanhoTotal, tamanhoParte: partBytes, estado: "uploading" satisfies UploadClientState });
              }
            });
            return true;
          }
          if (req.method === "DELETE") {
            shared.jobs.get(id)?.controller.abort();
            let remotePending = false;
            await withUploadLock(id, async () => {
              const state = await readState(id).catch(() => null);
              const receipt = await readCompletion(id);
              const session = state?.r2 ?? receipt?.r2;
              if (session || state?.drive) {
                if (state?.r2) {
                  state.r2.phase = "canceling";
                  state.atualizadoEm = now();
                  await writeState(id, state);
                  shared.jobs.get(id)?.controller.abort();
                }
                if (state?.drive) {
                  state.drive.phase = "canceling";
                  state.atualizadoEm = now();
                  await writeState(id, state);
                  shared.jobs.get(id)?.controller.abort();
                }
                remotePending = true;
                return;
              }
              await removeUpload(id);
            });
            if (remotePending) runCleanup();
            res.writeHead(remotePending ? 202 : 204); res.end();
            return true;
          }
          if (req.method === "PATCH") {
            await patch(id, req, res);
            return true;
          }
        }
        return false;
      } catch (error) {
        if (error instanceof UploadHttpError) { sendJson(res, { error: error.message }, error.status); return true; }
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") { sendJson(res, { error: "não há espaço suficiente no volume de Mídias" }, 507); return true; }
        throw error;
      }
    },
    close: async () => {
      if (closing) return;
      closing = true;
      shutdown.abort();
      clearInterval(interval);
      for (const job of imports.values()) job.controller.abort();
      staging?.close?.();
      await Promise.allSettled([...imports.values()].map(job => job.task));
      await cleanupTask;
      await withCapacityLock(async () => {
        shared.users--;
        if (shared.users === 0 && rootAdmissions.get(root) === shared) rootAdmissions.delete(root);
      });
    },
  };
  return runtime;
}
