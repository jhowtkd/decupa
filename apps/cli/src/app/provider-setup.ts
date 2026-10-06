import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readCredentials, writeCredentials, type Credentials } from "@decupa/triage";
import { validateJevProvider, validateVisualProvider } from "./provider-visual.ts";
import { readProviderBody } from "./provider-body.ts";
import { validateTextProvider } from "./provider-validation.ts";

export function validateProvider(value: unknown): Credentials {
  const creds = validateTextProvider(value);
  const v = value as Record<string, unknown>;
  if (v.visualProvider !== undefined || v.openaiApiKey !== undefined) Object.assign(creds, validateVisualProvider({ ...v, visualProvider: v.visualProvider ?? "openai" }));
  if (v.typesafe !== undefined || v.typesafeApiKey !== undefined) {
    const jev = validateJevProvider({ ...v, typesafe: v.typesafe ?? true });
    if (jev.typesafeApiKey) creds.typesafeApiKey = jev.typesafeApiKey;
    // Formulário opcional vazio não registra consentimento para uma chave futura.
    if (jev.typesafe === false) creds.typesafe = false;
    else if (jev.typesafeApiKey) creds.typesafe = true;
  }
  return creds;
}

/** Barreira da primeira abertura. Nunca devolve a chave nem chama o provedor. */
export async function providerSetup(req: IncomingMessage, res: ServerResponse, dir: string,
  read: typeof readCredentials = readCredentials): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  let configured = false;
  try { validateTextProvider(await read(dir)); configured = true; } catch { /* Primeira abertura ou configuração incompleta. */ }
  if (path === "/provider" && req.method === "POST") {
    // Primeira configuração apenas: não sobrescreve uma chave existente.
    if (configured) { json(409, { error: "Provedor já configurado neste computador." }); return true; }
    try {
      const creds = validateProvider(await readProviderBody(req));
      await writeCredentials(dir, creds);
      json(200, { configured: true });
    } catch {
      json(400, { error: "Não foi possível salvar. Confira provedor, chave, modelo, endpoint HTTPS e permissões locais." });
    }
    return true;
  }
  if (configured) return false;
  if (path === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
    res.end(await readFile(new URL("./provider-setup.html", import.meta.url), "utf8"));
  } else json(428, { error: "Configure o provedor de IA na primeira abertura do Decupa." });
  return true;
}
