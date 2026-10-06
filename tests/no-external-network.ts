import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, vi } from "vitest";

// A ausência de chave não é isolamento: uma regressão ainda poderia enviar mídia.
// Os testes HTTP do app usam loopback; provedores só passam por fetchImpl falso.
// Cobre o fetch global; clientes http/https/undici próprios exigem injeção falsa.
export function networkGuard(localFetch: typeof fetch) {
  const blocked: string[] = [];
  return {
    fetch: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        blocked.push(url.origin);
        throw new Error(`rede externa bloqueada no teste: ${url.origin}`);
      }
      return localFetch(input, init);
    }) as typeof fetch,
    assertClear: () => {
      // A checagem continua falhando mesmo se o código engolir o erro de fetch.
      const attempts = blocked.splice(0);
      expect(attempts, "tentativas de rede externa bloqueadas").toEqual([]);
    },
  };
}
const guard = networkGuard(globalThis.fetch);
globalThis.fetch = guard.fetch;
afterEach(guard.assertClear);
const realHome = homedir();

// A suíte inteira usa credenciais de fixture, nunca as do usuário da máquina.
vi.mock("../packages/triage/src/credentials.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../packages/triage/src/credentials.ts")>();
  return { ...original, readCredentials: async (dir: string) => {
    if ([realHome, homedir()].includes(resolve(dir))) return null;
    return original.readCredentials(dir);
  } };
});
