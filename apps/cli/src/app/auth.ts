import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedHostConfig } from "../http/origin.ts";

export const SESSION_COOKIE = "decupa_session";
export const MAX_DISPLAY_NAME_LENGTH = 80;
const DEFAULT_SESSION_DAYS = 14;
const SECRET_FILE = "session-secret";
const LOGIN_BODY_BYTES = 64 * 1024;
const FAILURE_RETENTION_MS = 60 * 60 * 1000;
const MAX_FAILURE_ENTRIES = 10_000;

type SessionPayload = {
  nome: string;
  emitidoEm: number;
  expiraEm: number;
  geração: string;
};

type RequestWithIdentity = IncomingMessage & { decupaIdentity?: string };

export interface AuthRuntime {
  /** Rotas abertas e endpoints da sessão; devolve true quando respondeu. */
  handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Middleware único antes das rotas do Projeto e da Mídia. */
  authorize(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  close(): Promise<void>;
  enabled: boolean;
}

export interface AuthRuntimeOptions {
  env: Record<string, string | undefined>;
  configDir?: string;
  network: ResolvedHostConfig;
  now?: () => number;
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

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function effectiveHttps(req: IncomingMessage, network: ResolvedHostConfig): boolean {
  if (network.trustProxy) {
    const forwarded = header(req, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) return forwarded === "https";
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/** Barra invertida ou caractere de controle: navegadores normalizam ambos de
 *  formas que podem tirar o `next` do site. */
function unsafeNextChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function localNext(value: string | null | undefined): string {
  if (!value || unsafeNextChar(value)) return "/";
  let decodedValue: string;
  try { decodedValue = decodeURIComponent(value); }
  catch { return "/"; }
  if (unsafeNextChar(decodedValue)) return "/";
  try {
    const parsed = new URL(value, "http://x.invalid");
    if (parsed.origin !== "http://x.invalid") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function acceptsHtml(req: IncomingMessage): boolean {
  return header(req, "accept")?.toLowerCase().split(",").some(value => value.trim().startsWith("text/html")) === true;
}

function parseCookies(value: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decoded(value: string): string | null {
  try { return Buffer.from(value, "base64url").toString("utf8"); }
  catch { return null; }
}

function sign(value: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function cookie(value: string, secure: boolean, maxAge?: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    ...(secure ? ["Secure"] : []),
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
  ].join("; ");
}

function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > MAX_DISPLAY_NAME_LENGTH) return null;
  return trimmed;
}

function systemName(): string {
  try {
    const name = userInfo().username.trim();
    if (name) return name;
  } catch { /* ambientes mínimos podem não expor userInfo */ }
  return process.env.USER?.trim() || process.env.USERNAME?.trim() || "usuário local";
}

async function persistedSecret(configDir: string): Promise<Buffer> {
  const secretDir = join(configDir, ".decupa");
  const path = join(secretDir, SECRET_FILE);
  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  await chmod(secretDir, 0o700).catch(() => {});
  try {
    const current = (await readFile(path, "utf8")).trim();
    if (current) {
      await chmod(path, 0o600).catch(() => {});
      return Buffer.from(current, "base64url");
    }
  } catch { /* primeira subida */ }

  const generated = randomBytes(32).toString("base64url");
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${generated}\n`, "utf8"); }
    finally { await handle.close(); }
  } catch (error) {
    // Dois processos podem subir o mesmo servidor ao mesmo tempo: quem
    // perdeu a criação lê o segredo que o vencedor acabou de persistir.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600).catch(() => {});
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = (await readFile(path, "utf8")).trim();
    if (current) return Buffer.from(current, "base64url");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("segredo de sessão persistido vazio");
}

async function readLoginBody(req: IncomingMessage): Promise<{ senha?: unknown; nome?: unknown }> {
  const declared = Number(header(req, "content-length"));
  if (declared > LOGIN_BODY_BYTES) throw new Error("body grande demais");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= LOGIN_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > LOGIN_BODY_BYTES) throw new Error("body grande demais");
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as { senha?: unknown; nome?: unknown };
  } catch {
    throw new Error("body inválido");
  }
}

function requestIp(req: IncomingMessage, network: ResolvedHostConfig): string {
  if (network.trustProxy) {
    const forwarded = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "desconhecido";
}

/** Login sem dependência externa: o mesmo middleware serve Limpeza, Montagem,
 * Acervo de Mídias e o marcador web. */
export async function createAuthRuntime(opts: AuthRuntimeOptions): Promise<AuthRuntime> {
  const password = opts.env.DECUPA_AUTH_PASSWORD;
  const enabled = typeof password === "string" && password.length > 0;
  const now = opts.now ?? Date.now;
  const configDir = opts.configDir ?? homedir();
  const secret = enabled
    ? (opts.env.DECUPA_SESSION_SECRET?.trim()
      ? Buffer.from(opts.env.DECUPA_SESSION_SECRET.trim(), "utf8")
      : await persistedSecret(configDir))
    : Buffer.alloc(0);
  const generation = enabled
    ? createHmac("sha256", secret).update(`decupa-session-generation:${password!}`, "utf8").digest("hex").slice(0, 32)
    : "";
  const daysValue = Number(opts.env.DECUPA_SESSION_DAYS);
  const sessionMs = (Number.isFinite(daysValue) && daysValue > 0 ? daysValue : DEFAULT_SESSION_DAYS) * 24 * 60 * 60 * 1000;
  const failures = new Map<string, { count: number; blockedUntil: number; lastFailureAt: number }>();

  function pruneFailures(timestamp: number): void {
    for (const [ip, state] of failures) {
      if (state.blockedUntil <= timestamp && timestamp - state.lastFailureAt > FAILURE_RETENTION_MS) failures.delete(ip);
    }
    if (failures.size <= MAX_FAILURE_ENTRIES) return;
    const oldest = [...failures.entries()]
      .sort(([, left], [, right]) => left.lastFailureAt - right.lastFailureAt);
    for (const [ip] of oldest.slice(0, failures.size - MAX_FAILURE_ENTRIES)) failures.delete(ip);
  }

  function validSession(req: IncomingMessage): string | null {
    if (!enabled) return systemName();
    const value = parseCookies(header(req, "cookie")).get(SESSION_COOKIE);
    if (!value) return null;
    const separator = value.lastIndexOf(".");
    if (separator <= 0) return null;
    const raw = value.slice(0, separator);
    const received = value.slice(separator + 1);
    const expected = sign(raw, secret);
    if (!constantTimeTextEqual(received, expected)) return null;
    const json = decoded(raw);
    if (!json) return null;
    try {
      const payload = JSON.parse(json) as Partial<SessionPayload>;
      if (typeof payload.nome !== "string" || typeof payload.emitidoEm !== "number"
        || typeof payload.expiraEm !== "number" || typeof payload.geração !== "string") return null;
      if (payload.geração !== generation || payload.expiraEm <= now() || payload.emitidoEm > now() + 60_000) return null;
      return displayName(payload.nome);
    } catch { return null; }
  }

  function authenticate(req: IncomingMessage, res: ServerResponse): boolean {
    const identity = validSession(req);
    if (identity) {
      (req as RequestWithIdentity).decupaIdentity = identity;
      return true;
    }
    if (!acceptsHtml(req)) {
      sendJson(res, { error: "sessão necessária" }, 401);
      return false;
    }
    const next = localNext(`${new URL(req.url ?? "/", "http://localhost").pathname}${new URL(req.url ?? "/", "http://localhost").search}`);
    res.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store" });
    res.end();
    return false;
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/healthz" && req.method === "GET") {
      sendJson(res, { ok: true });
      return true;
    }
    if (url.pathname === "/login" && req.method === "GET") {
      const page = await readFile(new URL("./login/page.html", import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page.replaceAll("__DECUPA_NEXT__", encoded(localNext(url.searchParams.get("next")))));
      return true;
    }
    if (url.pathname === "/login.css" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(await readFile(new URL("./login/page.css", import.meta.url), "utf8"));
      return true;
    }
    if (url.pathname === "/login.js" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(await readFile(new URL("./login/page.js", import.meta.url), "utf8"));
      return true;
    }
    if (url.pathname === "/logout" && req.method === "POST") {
      res.setHeader("set-cookie", cookie("", effectiveHttps(req, opts.network), 0));
      sendJson(res, { ok: true });
      return true;
    }
    if (url.pathname !== "/login" || req.method !== "POST") return false;
    const ip = requestIp(req, opts.network);
    const timestamp = now();
    pruneFailures(timestamp);
    const state = failures.get(ip);
    if (state && state.blockedUntil > timestamp) {
      res.setHeader("retry-after", String(Math.ceil((state.blockedUntil - timestamp) / 1000)));
      sendJson(res, { error: "tente novamente mais tarde" }, 429);
      return true;
    }
    let body: { senha?: unknown; nome?: unknown };
    try { body = await readLoginBody(req); }
    catch (error) { sendJson(res, { error: error instanceof Error ? error.message : "body inválido" }, 400); return true; }
    const validPassword = typeof body.senha === "string" && constantTimeTextEqual(body.senha, password!);
    const nome = displayName(body.nome);
    if (!validPassword || !nome) {
      const count = (state?.count ?? 0) + 1;
      const delay = count >= 3 ? Math.min(30_000, 1_000 * 2 ** Math.min(count - 3, 5)) : 0;
      failures.set(ip, { count, blockedUntil: timestamp + delay, lastFailureAt: timestamp });
      pruneFailures(timestamp);
      if (delay) {
        res.setHeader("retry-after", String(Math.ceil(delay / 1000)));
        sendJson(res, { error: "tente novamente mais tarde" }, 429);
      } else sendJson(res, { error: "senha ou nome inválido" }, 401);
      return true;
    }
    failures.delete(ip);
    const emitidoEm = now();
    const payload: SessionPayload = { nome, emitidoEm, expiraEm: emitidoEm + sessionMs, geração: generation };
    const raw = encoded(JSON.stringify(payload));
    res.setHeader("set-cookie", cookie(`${raw}.${sign(raw, secret)}`, effectiveHttps(req, opts.network), Math.floor(sessionMs / 1000)));
    res.writeHead(303, { location: localNext(url.searchParams.get("next")), "cache-control": "no-store" });
    res.end();
    return true;
  }

  return {
    enabled,
    handlePublic: handleLogin,
    authorize: (req, res, _url) => enabled ? authenticate(req, res) : (() => {
      (req as RequestWithIdentity).decupaIdentity = systemName();
      return true;
    })(),
    close: async () => { failures.clear(); },
  };
}

/** Identidade já resolvida pelo middleware, para handlers que precisam criar
 * avisos editoriais sem conhecer a forma do cookie. */
export function requestIdentity(req: IncomingMessage): string | undefined {
  return (req as RequestWithIdentity).decupaIdentity;
}

