import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile,
  type FileHandle,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { probe } from "@decupa/media";
import { createR2Staging, type R2Staging, type StagingPart } from "./r2-staging.ts";
import { createDriveImport, DriveHttpError, parseDriveFileId, type DriveImport } from "./drive-import.ts";

/** Estados que a interface do navegador usa para acompanhar um envio. */
export type UploadClientState = "uploading" | "paused" | "importing" | "verifying" | "ready" | "deduped" | "failed";

/** Snippet do protótipo: pausar retoma o mesmo envio, não cria outro. */
export const UPLOAD_STATE_FLOW = "uploading ⇄ paused → verifying → ready | deduped | failed";

const JSON_LIMIT = 1024 * 1024;
const DEFAULT_MAX_GB = 20;
const DEFAULT_PART_BYTES = 20 * 1024 * 1024;
const DEFAULT_TTL_HOURS = 24;
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

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

  const locks = new Map<string, Promise<unknown>>();
  // O hash em memória só vale para os bytes que ele próprio viu. Outro
  // processo (ou outro runtime) pode ter gravado partes no mesmo envio:
  // o tamanho do parcial bate com o estado, mas o hash ficou para trás.
  const hashes = new Map<string, { hash: Hash; bytes: number }>();
  const imports = new Map<string, { task: Promise<void>; controller: AbortController }>();
  let closing = false;
  let cleanupTask: Promise<void> | undefined;
  let cleanupRequested = false;

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
      if (typeof state.nome !== "string" || !Number.isSafeInteger(state.tamanhoTotal) || !Number.isSafeInteger(state.recebido)) {
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

  async function hasSpace(tamanho: number): Promise<boolean> {
    try {
      const usage = await statfs(root);
      return Number(usage.bavail) * Number(usage.bsize) >= tamanho + SPACE_MARGIN_BYTES;
    } catch {
      // Se o sistema não expõe statfs, o write ainda é a fonte de verdade.
      return true;
    }
  }

  async function removeUpload(id: string): Promise<void> {
    hashes.delete(id);
    await rm(join(temporary, id), { recursive: true, force: true });
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
      await open(path, "a").then(async (handle) => { await handle.truncate(state.recebido); await handle.close(); });
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

  async function publish(id: string, state: UploadState, hash: Hash): Promise<{ mediaId: string; deduplicado: boolean }> {
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
  }

  async function recoverCompleted(id: string, state: UploadState): Promise<{ mediaId: string; deduplicado: boolean }> {
    return publish(id, state, await ensureHash(id, state));
  }

  async function patch(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
          sendJson(res, await recoverCompleted(id, state), 201);
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
        await file.truncate(state.recebido);
        hashes.delete(id);
        throw error;
      } finally {
        await file.close();
      }

      const next: UploadState = { ...state, recebido: range.end + 1, atualizadoEm: now() };
      try {
        await writeState(id, next);
      } catch (error) {
        // O parcial já foi escrito, mas o estado ainda aponta para o offset
        // anterior. Não deixe o hash em memória representar bytes invisíveis.
        hashes.delete(id);
        const rollback = await open(partialPath(id), "r+").catch(() => null);
        if (rollback) {
          try { await rollback.truncate(state.recebido); } finally { await rollback.close(); }
        }
        throw error;
      }
      if (next.recebido === next.tamanhoTotal) {
        sendJson(res, await publish(id, next, hash), 201);
      } else {
        sendJson(res, { offset: next.recebido });
      }
    });
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
    if (closing || imports.has(id)) return;
    const controller = new AbortController();
    const { signal } = controller;
    const task = (async () => {
      try {
        const state = await withUploadLock(id, async () => {
          if (await readCompletion(id)) { await removeUpload(id); runCleanup(); return null; }
          return readState(id);
        });
        if (!state?.r2 || state.r2.phase !== "importing" || signal.aborted) return;
        const remote = requireStaging();
        const object = await remote.head(state.r2.key);
        signal.throwIfAborted();
        if (!object || object.size !== state.tamanhoTotal) throw new UploadHttpError(422, "tamanho do objeto R2 não confere");
        // A importação recomeça do objeto íntegro. Recolha o parcial de uma
        // tentativa anterior antes de conferir espaço para a nova cópia.
        await rm(partialPath(id), { force: true });
        if (!await hasSpace(state.tamanhoTotal)) throw new UploadHttpError(507, "não há espaço suficiente no volume de Mídias");
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
          await writeState(id, current);
          await publish(id, current, hash);
        });
        runCleanup();
      } catch (error) {
        await withUploadLock(id, async () => {
          // Se a queda ocorreu depois de publicar, o recibo é a fonte de verdade.
          if (await readCompletion(id)) { runCleanup(); await removeUpload(id); return; }
          await rm(partialPath(id), { force: true });
          if (closing || signal.aborted) return;
          const current = await readState(id).catch(() => null);
          if (!current?.r2 || current.r2.phase === "canceling") return;
          current.r2.phase = "failed";
          current.r2.status = error instanceof UploadHttpError ? error.status : 502;
          current.r2.error = error instanceof UploadHttpError ? error.message : "não foi possível importar do R2; tente novamente";
          current.recebido = 0;
          current.atualizadoEm = now();
          await writeState(id, current);
        });
      }
    })().catch(() => log(`falha na importação R2 ${id}`, new Error("o envio pode ser retomado")));
    imports.set(id, { task, controller });
    void task.finally(() => { if (imports.get(id)?.task === task) imports.delete(id); });
  }

  // Download do Drive com retomada por Range. Falha de rede preserva o
  // parcial e o offset; falha de integridade (422) descarta o parcial.
  // A conferência de espaço desconta o que já foi baixado.
  function startDriveImport(id: string): void {
    if (closing || imports.has(id)) return;
    const controller = new AbortController();
    const { signal } = controller;
    let received = 0;
    let file: FileHandle | null = null;
    const task = (async () => {
      try {
        const state = await withUploadLock(id, async () => {
          if (await readCompletion(id)) { await removeUpload(id); runCleanup(); return null; }
          return readState(id);
        });
        if (!state?.drive || state.drive.phase !== "downloading" || signal.aborted) return;
        const remote = requireDrive();
        const total = state.tamanhoTotal;
        const expectedMd5 = state.drive.md5;
        received = state.recebido;
        const existing = await stat(partialPath(id)).catch(() => null);
        if (!existing || existing.size < received) received = 0;
        file = await open(partialPath(id), received === 0 ? "w" : "r+");
        if (received > 0 && existing!.size > received) await file.truncate(received);
        let sha = createHash("sha256");
        let md5 = createHash("md5");
        if (received > 0) {
          for await (const chunk of createReadStream(partialPath(id))) {
            sha.update(chunk as Buffer);
            md5.update(chunk as Buffer);
          }
        }
        if (!await hasSpace(total - received)) throw new UploadHttpError(507, "não há espaço suficiente no volume de Mídias");
        const stream = await remote.read(state.drive.fileId, received, total, signal);
        signal.throwIfAborted();
        if (stream.restarted) {
          received = 0;
          sha = createHash("sha256");
          md5 = createHash("md5");
          await file.truncate(0);
          await withUploadLock(id, async () => {
            const current = await readState(id).catch(() => null);
            if (signal.aborted || current?.drive?.phase !== "downloading") throw DRIVE_INTERRUPTED;
            current.recebido = 0;
            current.atualizadoEm = now();
            await writeState(id, current);
          });
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
        // Só a publicação ocupa o lock. Um DELETE pode persistir canceling e
        // abortar o stream enquanto o download ainda está em andamento.
        await withUploadLock(id, async () => {
          const current = await readState(id).catch(() => null);
          if (signal.aborted || current?.drive?.phase !== "downloading") return;
          current.recebido = received;
          current.atualizadoEm = now();
          await writeState(id, current);
          await publish(id, current, sha);
        });
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
          current.atualizadoEm = now();
          await writeState(id, current);
        });
      } finally {
        if (file) await file.close().catch(() => {});
      }
    })().catch(() => log(`falha na importação do Drive ${id}`, new Error("a importação pode ser retomada")));
    imports.set(id, { task, controller });
    void task.finally(() => { if (imports.get(id)?.task === task) imports.delete(id); });
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
    const result = { transporte: "r2", tamanhoTotal: state.tamanhoTotal, tamanhoParte: session.partBytes };
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
    const result = { transporte: "drive", tamanhoTotal: state.tamanhoTotal, nome: state.nome };
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

  async function cleanExpired(localOnly = false): Promise<void> {
    const cutoff = now() - ttlMs;
    for (const entry of await readdir(temporary, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uploadId(entry.name)) continue;
      const state = await readFile(join(temporary, entry.name, "state.json"), "utf8")
        .then((raw) => JSON.parse(raw) as UploadState, () => null);
      // Drive não tem cópia remota para limpar: o cancelamento só remove o
      // parcial. Sem rede envolvida, vale também na limpeza de inicialização.
      if (state?.drive?.phase === "canceling") {
        await removeUpload(entry.name)
          .catch(() => log(`cancelamento do Drive pendente ${entry.name}`, new Error("a limpeza será repetida")));
        continue;
      }
      if ((state?.r2 || state?.drive) && localOnly) continue;
      if (state?.r2?.phase === "canceling" && staging) {
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
              imports.get(entry.name)?.controller.abort();
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
  for (const entry of await readdir(temporary, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uploadId(entry.name)) continue;
    const state = await readState(entry.name).catch(() => null);
    if (state?.r2?.phase === "importing") startImport(entry.name);
    if (state?.drive?.phase === "downloading") startDriveImport(entry.name);
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
              const info = await probe(join(pool, sha256));
              const metadata: MediaMetadata = {
                id: sha256, nome, tamanho: (await stat(join(pool, sha256))).size,
                duracao: info.durationMs / 1000, criadoEm: now(),
              };
              await writeMetadata(sha256, metadata);
            }
            sendJson(res, { mediaId: sha256, deduplicado: true });
            return true;
          }
          if (tamanho > maxBytes) throw new UploadHttpError(413, "mídia acima do tamanho máximo");
          if (!(await hasSpace(tamanho))) throw new UploadHttpError(507, "não há espaço suficiente no volume de Mídias");
          const id = randomUUID();
          await mkdir(join(temporary, id));
          await writeFile(partialPath(id), Buffer.alloc(0));
          let r2: R2Session | undefined;
          try {
            if (staging) {
              const key = `decupa-staging/${id}`;
              const size = Math.max(5 * 1024 * 1024, partBytes, Math.ceil(tamanho / 10_000));
              r2 = { key, upload: await staging.create(key), partBytes: size, phase: "uploading" };
            }
            await writeState(id, { nome, tamanhoTotal: tamanho, recebido: 0, criadoEm: now(), atualizadoEm: now(), sha256, r2 });
          } catch (error) {
            if (r2) await staging!.abort(r2.key, r2.upload).catch(() => {});
            await removeUpload(id);
            throw error;
          }
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
          if (!(await hasSpace(file.tamanho))) throw new UploadHttpError(507, "não há espaço suficiente no volume de Mídias");
          const id = randomUUID();
          const nome = sanitizeDriveName(file.nome);
          await mkdir(join(temporary, id));
          await writeFile(partialPath(id), Buffer.alloc(0));
          await writeState(id, {
            nome, tamanhoTotal: file.tamanho, recebido: 0, criadoEm: now(), atualizadoEm: now(),
            drive: { fileId, md5: file.md5, phase: "downloading" },
          });
          startDriveImport(id);
          sendJson(res, { id, transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: file.tamanho, nome }, 202);
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
              state.drive.phase = "downloading";
              delete state.drive.error;
              delete state.drive.status;
              state.atualizadoEm = now();
              await writeState(id, state);
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
              if (imports.has(id)) { sendJson(res, { transporte: "r2", estado: "importing" }, 202); return; }
              const remote = requireStaging();
              if (parts[3] === "parts") {
                if (session.phase !== "uploading") throw new UploadHttpError(409, "envio já finalizado");
                const body = await readJson(req);
                const numero = integer(body.numero, "número da parte inválido");
                if (numero < 1 || numero > Math.ceil(state.tamanhoTotal / session.partBytes)) throw new UploadHttpError(400, "número da parte inválido");
                const signed = await remote.signPart(session.key, session.upload, numero);
                state.atualizadoEm = now();
                await writeState(id, state);
                sendJson(res, { url: signed });
              } else {
                // HEAD torna a conclusão repetível mesmo se a resposta do R2
                // se perdeu depois de ele concluir o multipart.
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
                startImport(id);
                sendJson(res, { transporte: "r2", estado: "importing" }, 202);
              }
            });
            return true;
          }
          if (parts.length !== 3) return false;
          if (req.method === "GET") {
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
                const result = await recoverCompleted(id, state);
                sendJson(res, { ...result, offset: state.recebido, tamanhoTotal: state.tamanhoTotal, estado: result.deduplicado ? "deduped" : "ready" satisfies UploadClientState });
              } else {
                sendJson(res, { offset: state.recebido, tamanhoTotal: state.tamanhoTotal, tamanhoParte: partBytes, estado: "uploading" satisfies UploadClientState });
              }
            });
            return true;
          }
          if (req.method === "DELETE") {
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
                  imports.get(id)?.controller.abort();
                }
                if (state?.drive) {
                  state.drive.phase = "canceling";
                  state.atualizadoEm = now();
                  await writeState(id, state);
                  imports.get(id)?.controller.abort();
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
      closing = true;
      clearInterval(interval);
      for (const job of imports.values()) job.controller.abort();
      staging?.close?.();
      await Promise.allSettled([...imports.values()].map(job => job.task));
    },
  };
  return runtime;
}
