import { analysisClientOptions, PRESETS, type Credentials } from "@decupa/triage";
import { validateTextProvider } from "./provider-validation.ts";

export class SettingsInputError extends Error {}

/** O estado descreve o mesmo arquivo resolvido pelo transporte, sem devolver a chave. */
export function textProviderState(env: Record<string, string | undefined>, stored: Credentials | null) {
  const source = (stored as (Credentials & { textProviderSource?: string }) | null)?.textProviderSource
    ?? (stored ? "credentials" : "environment");
  try {
    const resolved = analysisClientOptions({ stored, env });
    const preset = stored?.preset ?? Object.keys(PRESETS).find(name => env[PRESETS[name as keyof typeof PRESETS].envKey])!;
    const endpoint = new URL(resolved.baseUrl!);
    return { configured: true, preset, model: resolved.model, baseUrl: endpoint.href, host: endpoint.host, source,
      defaultBaseUrl: PRESETS[preset as keyof typeof PRESETS].baseUrl,
      notice: source === "project" ? "Este projeto tem credenciais próprias. O que você salvar vale para os outros projetos; o arquivo deste projeto permanece como está."
        : source === "environment" ? "A chave do ambiente está em uso porque não há configuração salva." : null };
  } catch {
    return { configured: false, preset: stored?.preset ?? "zai", model: null, baseUrl: null, host: null, source,
      notice: "Configure o provedor de texto." };
  }
}

/** Uma mudança de destino nunca aproveita a chave antiga, mesmo sem chamada durante o save. */
export function textProviderFields(body: Record<string, unknown>, previous: Credentials): Credentials {
  if (Object.keys(body).some(key => !["section", "preset", "apiKey", "baseUrl", "model"].includes(key))) throw new SettingsInputError("Configuração inválida.");
  const incomingKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new SettingsInputError("Configuração inválida.");
  if (incomingKey && (incomingKey.length > 400 || /[\s\p{Cc}]/u.test(incomingKey))) throw new SettingsInputError("Confira a chave de API.");
  const preset = body.preset ?? previous.preset;
  if (preset !== previous.preset && !incomingKey && typeof preset === "string" && Object.hasOwn(PRESETS, preset)) {
    throw new SettingsInputError("Informe a chave do novo provedor");
  }
  let next: Credentials;
  try { next = validateTextProvider({ ...(preset === previous.preset ? previous : {}), ...body, preset, apiKey: incomingKey || previous.apiKey }); }
  catch { throw new SettingsInputError("Confira provedor, chave, modelo e endpoint HTTPS."); }
  const before = analysisClientOptions({ env: {}, stored: previous });
  const after = analysisClientOptions({ env: {}, stored: next });
  if ((next.preset !== previous.preset || new URL(before.baseUrl!).href !== new URL(after.baseUrl!).href) && !incomingKey) {
    throw new SettingsInputError("Informe a chave do novo provedor");
  }
  // undefined também atravessa o merge: vazio não pode ressuscitar o destino antigo.
  return { ...next, model: next.model, baseUrl: next.baseUrl };
}
