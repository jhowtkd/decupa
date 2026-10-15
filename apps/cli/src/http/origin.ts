import type { ServerResponse } from "node:http";

export interface HostConfig {
  allowedHosts?: string;
  allowedOrigins?: string;
  trustProxy?: boolean;
}

export interface ResolvedHostConfig {
  hosts: string[];
  origins: string[];
  trustProxy: boolean;
}

/** Lê somente o ambiente recebido pelo chamador; não consulta o ambiente global depois. */
export function hostConfig(env: Record<string, string | undefined> = process.env): HostConfig {
  return {
    allowedHosts: env.DECUPA_ALLOWED_HOSTS,
    allowedOrigins: env.DECUPA_ALLOWED_ORIGINS,
    trustProxy: env.DECUPA_TRUST_PROXY === "1" || env.DECUPA_TRUST_PROXY === "true",
  };
}

export function resolveHostConfig(config: HostConfig): ResolvedHostConfig {
  return {
    hosts: splitList(config.allowedHosts),
    origins: splitList(config.allowedOrigins),
    trustProxy: config.trustProxy === true,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
}

function resolved(config: HostConfig | ResolvedHostConfig | undefined): ResolvedHostConfig {
  if (config && "hosts" in config) return config;
  return resolveHostConfig(config ?? {});
}

interface ParsedHost {
  name: string;
  port?: string;
}

function parseHost(value: string): ParsedHost | undefined {
  const text = value.trim().toLowerCase();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return undefined;
    const name = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest === "") return { name };
    if (!/^:\d+$/.test(rest)) return undefined;
    return { name, port: rest.slice(1) };
  }
  const colon = text.lastIndexOf(":");
  if (colon >= 0 && /^\d+$/.test(text.slice(colon + 1))) {
    return { name: text.slice(0, colon), port: text.slice(colon + 1) };
  }
  if (text.includes(":")) return { name: text };
  return { name: text };
}

function hostMatches(value: string, allowed: string, port: number): boolean {
  const actual = parseHost(value);
  const expected = parseHost(allowed);
  if (!actual || !expected || actual.name !== expected.name) return false;
  if (expected.port !== undefined) return actual.port === expected.port;
  return actual.port === undefined || actual.port === "80" || actual.port === "443" || actual.port === String(port);
}

function localOriginAllowed(origin: string, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function forwardedProto(config: ResolvedHostConfig, req?: { headers: { [key: string]: string | string[] | undefined } }): string | undefined {
  if (!config.trustProxy) return undefined;
  return req?.headers["x-forwarded-proto"]?.toString().split(",")[0].trim().toLowerCase();
}

export function effectiveHost(
  req: { headers: { host?: string; [key: string]: string | string[] | undefined } },
  config?: HostConfig | ResolvedHostConfig,
): string | undefined {
  const c = resolved(config);
  if (c.trustProxy) {
    const forwarded = req.headers["x-forwarded-host"];
    if (typeof forwarded === "string" && forwarded.split(",")[0].trim()) return forwarded.split(",")[0].trim().toLowerCase();
  }
  return req.headers.host?.toLowerCase();
}

/** O navegador manda Origin em toda requisição não-GET; a ausência passa para scripts. */
export function originAllowed(
  origin: string | undefined,
  port: number,
  config?: HostConfig | ResolvedHostConfig,
  req?: { headers: { [key: string]: string | string[] | undefined } },
): boolean {
  if (origin === undefined) return true;
  const c = resolved(config);
  const value = origin.toLowerCase();
  if (forwardedProto(c, req) === "https" && !value.startsWith("https://")) return false;
  if (c.origins.length) return c.origins.includes(value);
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const originHost = parsed.hostname.includes(":") ? `[${parsed.hostname}]:${originPort}` : `${parsed.hostname}:${originPort}`;
  return c.hosts.some(host => hostMatches(originHost, host, port)) || localOriginAllowed(value, port);
}

/** O `Host` continua sendo o portão contra DNS rebinding. */
export function hostAllowed(host: string | undefined, port: number, config?: HostConfig | ResolvedHostConfig): boolean {
  if (host === undefined) return false;
  const c = resolved(config);
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || c.hosts.some(allowed => hostMatches(value, allowed, port));
}

/** Portão comum: Host fora da lista recebe 403 antes de qualquer rota. */
export function guardLocalRequest(
  req: { headers: { host?: string; [key: string]: string | string[] | undefined } },
  res: ServerResponse,
  port: number,
  config?: HostConfig | ResolvedHostConfig,
): boolean {
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-frame-options", "DENY");
  if (hostAllowed(effectiveHost(req, config), port, config)) return true;
  const payload = JSON.stringify({ error: "host não permitido" });
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
  return false;
}
