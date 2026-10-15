import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { probe } from "@decupa/media";

/** Estados que a interface do navegador usa para acompanhar um envio. */
export type UploadClientState = "uploading" | "paused" | "verifying" | "ready" | "deduped" | "failed";

/** Snippet do protótipo: pausar retoma o mesmo envio, não cria outro. */
export const UPLOAD_STATE_FLOW = "uploading ⇄ paused → verifying → ready | deduped | failed";

const JSON_LIMIT = 1024 * 1024;
const DEFAULT_MAX_GB = 20;
const DEFAULT_PART_BYTES = 20 * 1024 * 1024;
const DEFAULT_TTL_HOURS = 24;
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

interface UploadState {
  nome: string;
  tamanhoTotal: number;
  recebido: number;
  criadoEm: number;
  atualizadoEm: number;
  sha256?: string;
}

interface MediaMetadata {
  id: string;
  nome: string;
  tamanho: number;
  duracao: number;
  criadoEm: number;
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
  close(): Promise<void>;
}

export interface MediaRuntimeOptions {
  root: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Acervo e envios ficam num runtime próprio para que sejam globais: não há
 * Reserva de Edição nem estado de Projeto envolvido no envio de uma Mídia.
 */
export async function createMediaRuntime(opts: MediaRuntimeOptions): Promise<MediaRuntime> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const root = opts.root;
  const pool = join(root, "pool");
  const temporary = join(root, ".tmp");
  const maxBytes = positiveNumber(env.DECUPA_UPLOAD_MAX_GB, DEFAULT_MAX_GB) * 1024 ** 3;
  const partBytes = Math.floor(positiveNumber(
    env.DECUPA_UPLOAD_PART_BYTES,
    positiveNumber(env.DECUPA_UPLOAD_PART_MB, DEFAULT_PART_BYTES / (1024 * 1024)) * 1024 * 1024,
  ));
  const ttlMs = nonNegativeNumber(env.DECUPA_UPLOAD_TTL_HOURS, DEFAULT_TTL_HOURS) * 60 * 60 * 1000;

  await mkdir(pool, { recursive: true });
  await mkdir(temporary, { recursive: true });

  const locks = new Map<string, Promise<unknown>>();
  const hashes = new Map<string, Hash>();

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

  async function ensureHash(id: string, state: UploadState): Promise<Hash> {
    const known = hashes.get(id);
    if (known) return known;
    const path = partialPath(id);
    const file = await stat(path).catch(() => null);
    if (!file || file.size !== state.recebido) {
      await open(path, "a").then(async (handle) => { await handle.truncate(state.recebido); await handle.close(); });
    }
    const hash = await hashPartial(path);
    hashes.set(id, hash);
    return hash;
  }

  async function publish(id: string, state: UploadState, hash: Hash): Promise<{ mediaId: string; deduplicado: boolean }> {
    const mediaId = hash.digest("hex");
    // `digest` encerra o hash: uma nova tentativa depois de uma falha abaixo
    // precisa recalculá-lo a partir do parcial, não reaproveitar este.
    hashes.delete(id);
    if (state.sha256 && state.sha256 !== mediaId) {
      await removeUpload(id);
      throw new UploadHttpError(422, "sha256 da mídia não confere");
    }
    const source = partialPath(id);
    let info;
    try { info = await probe(source); }
    catch (error) {
      await removeUpload(id);
      throw new UploadHttpError(422, error instanceof Error ? error.message : "mídia ilegível");
    }
    if ((!info.hasVideo && !info.hasAudio) || info.durationMs <= 0) {
      await removeUpload(id);
      throw new UploadHttpError(422, "mídia sem vídeo ou áudio legível");
    }

    return withHashLock(mediaId, async () => {
      const destination = join(pool, mediaId);
      const exists = await stat(destination).then(() => true, () => false);
      if (exists) {
        await removeUpload(id);
        return { mediaId, deduplicado: true };
      }
      await rename(source, destination);
      const metadata: MediaMetadata = {
        id: mediaId, nome: state.nome, tamanho: state.tamanhoTotal,
        duracao: info.durationMs / 1000, criadoEm: now(),
      };
      const metadataPath = join(pool, `${mediaId}.json`);
      const metadataPartial = `${metadataPath}.${randomUUID()}.partial`;
      try {
        await writeFile(metadataPartial, `${JSON.stringify(metadata)}\n`, "utf8");
        await rename(metadataPartial, metadataPath);
      } catch (error) {
        await rm(metadataPartial, { force: true });
        throw error;
      }
      await removeUpload(id);
      return { mediaId, deduplicado: false };
    });
  }

  async function patch(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    await withUploadLock(id, async () => {
      const state = await readState(id);
      const range = parseRange(typeof req.headers["content-range"] === "string" ? req.headers["content-range"] : undefined);
      const length = range.end - range.start + 1;
      if (range.total !== state.tamanhoTotal) throw new UploadHttpError(409, "tamanho total não confere");
      if (length > partBytes) throw new UploadHttpError(413, "parte do envio grande demais");
      if (range.end < state.recebido) {
        for await (const _chunk of req) { /* drena o reenvio sem segurá-lo na memória */ }
        sendJson(res, { offset: state.recebido });
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
          await file.write(buffer, 0, buffer.byteLength, range.start + received - buffer.byteLength);
          hash.update(buffer);
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
      await writeState(id, next);
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

  async function cleanExpired(): Promise<void> {
    const cutoff = now() - ttlMs;
    for (const entry of await readdir(temporary, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uploadId(entry.name)) continue;
      const state = await readFile(join(temporary, entry.name, "state.json"), "utf8")
        .then((raw) => JSON.parse(raw) as UploadState, () => null);
      // Sob o lock do envio: uma parte chegando agora não pode ter a pasta
      // apagada no meio da escrita.
      if (state && state.atualizadoEm <= cutoff) {
        await withUploadLock(entry.name, async () => {
          const current = await readState(entry.name).catch(() => null);
          if (current && current.atualizadoEm <= cutoff) await removeUpload(entry.name);
        });
      }
    }
  }

  await cleanExpired();
  const interval = setInterval(() => { void cleanExpired(); }, Math.max(1_000, Math.min(60 * 60 * 1000, ttlMs / 2 || 1_000)));
  interval.unref?.();

  const runtime: MediaRuntime = {
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
          const sha256 = optionalSha(body.sha256);
          if (sha256 && await stat(join(pool, sha256)).then(() => true, () => false)) {
            sendJson(res, { mediaId: sha256, deduplicado: true });
            return true;
          }
          if (tamanho > maxBytes) throw new UploadHttpError(413, "mídia acima do tamanho máximo");
          if (!(await hasSpace(tamanho))) throw new UploadHttpError(507, "não há espaço suficiente no volume de Mídias");
          const id = randomUUID();
          await mkdir(join(temporary, id));
          await writeFile(partialPath(id), Buffer.alloc(0));
          await writeState(id, { nome, tamanhoTotal: tamanho, recebido: 0, criadoEm: now(), atualizadoEm: now(), sha256 });
          sendJson(res, { id, offset: 0, tamanhoParte: partBytes }, 201);
          return true;
        }
        if (parts[0] === "api" && parts[1] === "uploads" && parts[2] && uploadId(parts[2])) {
          const id = parts[2];
          if (req.method === "GET") {
            const state = await readState(id);
            sendJson(res, { offset: state.recebido, tamanhoTotal: state.tamanhoTotal, estado: "uploading" satisfies UploadClientState });
            return true;
          }
          if (req.method === "DELETE") {
            await withUploadLock(id, async () => { await removeUpload(id); });
            res.writeHead(204); res.end();
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
    close: async () => { clearInterval(interval); },
  };
  return runtime;
}
