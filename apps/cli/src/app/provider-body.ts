import type { IncomingMessage } from "node:http";

/** Mesmo limite para as duas telas; rejeitar antes de gravar qualquer segredo. */
export async function readProviderBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Envie JSON.");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 16_384) throw new Error("Configuração excede o limite.");
  }
  return JSON.parse(raw);
}
