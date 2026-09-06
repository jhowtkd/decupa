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
