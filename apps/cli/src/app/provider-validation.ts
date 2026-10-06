import { analysisClientOptions, PRESETS, type Credentials } from "@decupa/triage";

/** Campos antigos continuam válidos; a barreira do texto não valida chaves opcionais antigas. */
export function validateTextProvider(value: unknown): Credentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuração inválida.");
  const v = value as Record<string, unknown>;
  if (typeof v.preset !== "string" || !Object.hasOwn(PRESETS, v.preset)) throw new Error("Escolha um provedor.");
  if (typeof v.apiKey !== "string" || !v.apiKey.trim()) throw new Error("Informe a chave de API.");
  const creds: Credentials = { preset: v.preset as Credentials["preset"], apiKey: v.apiKey.trim() };
  for (const key of ["model", "baseUrl"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") throw new Error("Configuração inválida.");
    if (typeof v[key] === "string" && v[key].trim()) creds[key] = v[key].trim();
  }
  const url = new URL(analysisClientOptions({ stored: creds, env: {} }).baseUrl!);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use um endpoint HTTPS sem credenciais ou parâmetros na URL.");
  return creds;
}

/** Rejeita erro de colagem antes de gravar; nunca verifica a conta nem ecoa a chave. */
export function optionalProviderKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Configuração inválida.");
  const key = value.trim();
  if (!key) return undefined;
  if (key.length < 20 || key.length > 400 || /[\s\p{Cc}]/u.test(key)) throw new Error("Configuração inválida.");
  return key;
}
