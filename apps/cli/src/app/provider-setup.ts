import type { IncomingMessage, ServerResponse } from "node:http";
import { readCredentials, writeCredentials, type Credentials } from "@decupa/triage";
import { validateJevProvider, validateVisualProvider } from "./provider-visual.ts";
import { readProviderBody } from "./provider-body.ts";
import { validateTextProvider } from "./provider-validation.ts";

export function validateProvider(value: unknown): Credentials {
  const creds = validateTextProvider(value);
  const v = value as Record<string, unknown>;
  if (v.visualProvider !== undefined || v.openaiApiKey !== undefined) Object.assign(creds, validateVisualProvider({ openaiApiKey: v.openaiApiKey, visualProvider: v.visualProvider ?? "openai" }));
  if (v.typesafe !== undefined || v.typesafeApiKey !== undefined) {
    const jev = validateJevProvider({ ...v, typesafe: v.typesafe ?? true });
    if (jev.typesafeApiKey) creds.typesafeApiKey = jev.typesafeApiKey;
    // Formulário opcional vazio não registra consentimento para uma chave futura.
    if (jev.typesafe === false) creds.typesafe = false;
    else if (jev.typesafeApiKey) creds.typesafe = true;
  }
  return creds;
}

/** Primeira configuração (POST /provider). Nunca devolve a chave nem chama o provedor.
 *  R3.1 sem-chave: a barreira cega que devolvia 428 para todo o resto saiu —
 *  sem chave o app abre e o uso local segue; o 428 agora é por rota de IA
 *  (triagem/modelo) e a leitura de /settings não exige mais chave. */
export async function providerSetup(req: IncomingMessage, res: ServerResponse, dir: string,
  read: typeof readCredentials = readCredentials): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (path !== "/provider" || req.method !== "POST") return false;
  // Primeira configuração apenas: não sobrescreve uma chave existente.
  let configured = false;
  try { validateTextProvider(await read(dir)); configured = true; } catch { /* Primeira abertura ou configuração incompleta. */ }
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
