import type { ServerResponse } from "node:http";

export interface HostConfig {
  allowedHosts?: string;
  allowedOrigins?: string;
  trustProxy?: boolean;
}

export function hostConfig(env: Record<string, string | undefined> = process.env): HostConfig {
  return { allowedHosts: env.DECUPA_ALLOWED_HOSTS, allowedOrigins: env.DECUPA_ALLOWED_ORIGINS, trustProxy: env.DECUPA_TRUST_PROXY === "1" || env.DECUPA_TRUST_PROXY === "true" };
}

function configured(config: HostConfig = {}): { hosts: string[]; origins: string[]; trustProxy: boolean } {
  const env = process.env;
  const hosts = (config.allowedHosts ?? env.DECUPA_ALLOWED_HOSTS ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  const origins = (config.allowedOrigins ?? env.DECUPA_ALLOWED_ORIGINS ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  return { hosts, origins, trustProxy: config.trustProxy ?? (env.DECUPA_TRUST_PROXY === "1" || env.DECUPA_TRUST_PROXY === "true") };
}

function hostMatches(value: string, allowed: string, port: number): boolean {
  const [name, declaredPort] = allowed.startsWith("[") ? [allowed, undefined] : allowed.split(":");
  if (declaredPort) return value === allowed;
  return value === `${name}:${port}` || (name === "localhost" && (value === "localhost:80" || value === "localhost:443")) || value === `${name}:80` || value === `${name}:443`;
}

export function effectiveHost(req: { headers: { host?: string; [key: string]: string | string[] | undefined } }, config?: HostConfig): string | undefined {
  const c = configured(config);
  if (c.trustProxy) {
    const forwarded = req.headers["x-forwarded-host"];
    if (typeof forwarded === "string" && forwarded.split(",")[0].trim()) return forwarded.split(",")[0].trim().toLowerCase();
  }
  return req.headers.host?.toLowerCase();
}

/**
 * Bind em 127.0.0.1 protege da rede, não do navegador: qualquer página aberta
 * na mesma máquina pode fazer POST em http://127.0.0.1:7788 e disparar render,
 * export ou cancel no material do cliente.
 *
 * O navegador manda `Origin` em toda requisição não-GET, inclusive same-origin,
 * então basta recusar o que não veio da própria página. Ausência de `Origin` é
 * cliente que não é navegador (curl, script) e continua passando — o SKILL
 * documenta chamar estas rotas na mão.
 */
export function originAllowed(origin: string | undefined, port: number, config?: HostConfig, req?: { headers: { [key: string]: string | string[] | undefined } }): boolean {
  if (origin === undefined) return true;
  const c = configured(config);
  const proto = c.trustProxy && req?.headers["x-forwarded-proto"]?.toString().split(",")[0].trim().toLowerCase();
  if (proto === "https" && !origin.toLowerCase().startsWith("https://")) return false;
  if (c.origins.length) return c.origins.includes(origin.toLowerCase());
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  return c.hosts.some(host => {
    const hasPort = host.includes(":") && !host.startsWith("[");
    return hasPort ? parsed.host === host : (parsed.hostname === host && (parsed.port === "" || parsed.port === "80" || parsed.port === "443"));
  }) || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/**
 * O `Origin` não cobre DNS rebinding: um domínio que passa a resolver para
 * 127.0.0.1 é same-origin para o navegador e lê `/project`, a mídia e os
 * downloads com GET. O `Host` continua sendo o nome do atacante, então só
 * passam os dois nomes da própria máquina — em toda rota, GET incluído.
 * curl e scripts mandam o `Host` da URL que usaram, que é um destes.
 */
export function hostAllowed(host: string | undefined, port: number, config?: HostConfig): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  const c = configured(config);
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || c.hosts.some(allowed => hostMatches(value, allowed, port));
}

/**
 * Portão comum dos servidores locais: `Host` fora da lista recebe 403 antes de
 * qualquer rota, e toda resposta proíbe ser emoldurada. Numa página dentro de
 * um iframe, o clique do usuário sai com o `Origin` legítimo e contornaria o
 * portão acima — inclusive no "Preparar" pago. Devolve false quando já
 * respondeu.
 */
export function guardLocalRequest(
  req: { headers: { host?: string } },
  res: ServerResponse,
  port: number,
  config?: HostConfig,
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
