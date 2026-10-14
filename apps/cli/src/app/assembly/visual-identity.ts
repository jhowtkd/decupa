import { createHash } from "node:crypto";
import { payloadProfileKey } from "@decupa/triage";

/** Uma chave de cache nunca carrega credenciais, query ou fragmento do endpoint. */
export function sanitizeProviderKey(value: string): string {
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return value.split("?")[0]!.split("#")[0]!; }
}

export function visualIdentityKey(
  client: { model?: string; providerKey?: string; profileKey?: string; payloadProfile?: "default" | "openai-reasoning-none" },
  promptProfile: "baseline" | "compact", promptVersion: number,
): string | null {
  if (!client.model || !client.providerKey) return null;
  // O payload padrão não mudou: manter a forma antiga evita reanálise paga
  // dos projetos existentes. Perfis novos acrescentam sua dependência.
  const profileKey = client.profileKey ?? payloadProfileKey({ profile: client.payloadProfile });
  const defaultProfile = client.payloadProfile === "default" || !client.payloadProfile && profileKey === payloadProfileKey();
  return createHash("sha256").update(JSON.stringify({
    version: "visual-v4", providerKey: sanitizeProviderKey(client.providerKey), model: client.model,
    ...(defaultProfile ? {} : { payloadProfile: profileKey }), profile: promptProfile,
    promptVersion, sampleFps: 1, frameMaxSize: 480,
  })).digest("hex");
}
