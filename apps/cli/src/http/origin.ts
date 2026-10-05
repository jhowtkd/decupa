import type { ServerResponse } from "node:http";

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
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/**
 * O `Origin` não cobre DNS rebinding: um domínio que passa a resolver para
 * 127.0.0.1 é same-origin para o navegador e lê `/project`, a mídia e os
 * downloads com GET. O `Host` continua sendo o nome do atacante, então só
 * passam os dois nomes da própria máquina — em toda rota, GET incluído.
 * curl e scripts mandam o `Host` da URL que usaram, que é um destes.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
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
): boolean {
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-frame-options", "DENY");
  if (hostAllowed(req.headers.host, port)) return true;
  const payload = JSON.stringify({ error: "host não permitido" });
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
  return false;
}
