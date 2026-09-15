import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analysisClientOptions, readCredentials, writeCredentials, PRESETS, type Credentials } from "@decupa/triage";

export function validateProvider(value: unknown): Credentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuração inválida.");
  const v = value as Record<string, unknown>;
  if (typeof v.preset !== "string" || !Object.hasOwn(PRESETS, v.preset)) throw new Error("Escolha um provedor.");
  if (typeof v.apiKey !== "string" || !v.apiKey.trim()) throw new Error("Informe a chave de API.");
  const creds: Credentials = { preset: v.preset as Credentials["preset"], apiKey: v.apiKey.trim() };
  for (const key of ["model", "baseUrl"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") throw new Error("Configuração inválida.");
    if (typeof v[key] === "string" && v[key].trim()) creds[key] = v[key].trim();
  }
  const config = analysisClientOptions({ stored: creds, env: {} });
  const url = new URL(config.baseUrl!);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use um endpoint HTTPS sem credenciais ou parâmetros na URL.");
  return creds;
}

/** Barreira da primeira abertura. Nunca devolve a chave nem chama o provedor. */
export async function providerSetup(req: IncomingMessage, res: ServerResponse, dir: string): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  let configured = false;
  try { validateProvider(await readCredentials(dir)); configured = true; } catch { /* Primeira abertura ou configuração incompleta. */ }
  if (path === "/provider" && req.method === "POST") {
    // Primeira configuração apenas: não sobrescreve uma chave existente.
    if (configured) { json(409, { error: "Provedor já configurado neste computador." }); return true; }
    try {
      if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Envie JSON.");
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 16_384) throw new Error("Configuração excede o limite.");
      }
      const creds = validateProvider(JSON.parse(raw));
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
