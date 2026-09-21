import { analysisClientOptions } from "./analysis-client.ts";
import { readCredentials, writeCredentials, type Credentials } from "./credentials.ts";
import { PRESETS, presetConfig, resolveProvider, type Provider } from "./provider.ts";

function isProvider(value: string): value is Provider {
  return Object.hasOwn(PRESETS, value);
}

function typeSafeFromEnv(env: Record<string, string | undefined>): Pick<Credentials, "typesafeApiKey" | "typesafe"> {
  const typesafeApiKey = env.DECUPA_COMPANY_TYPESAFE_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim();
  if (!typesafeApiKey) return {};
  return { typesafeApiKey, typesafe: env.DECUPA_TYPESAFE !== "0" };
}

/** Completa o env da sessão com Jev gravado em ~/.decupa/credentials. */
export function envWithStoredTypeSafe(
  env: Record<string, string | undefined>,
  stored: Credentials | null | undefined,
): Record<string, string | undefined> {
  const next = { ...env };
  if (!next.TYPESAFE_API_KEY?.trim() && stored?.typesafeApiKey) {
    next.TYPESAFE_API_KEY = stored.typesafeApiKey;
  }
  if (next.DECUPA_TYPESAFE == null && stored?.typesafe) next.DECUPA_TYPESAFE = "1";
  return next;
}

/**
 * Credencial da empresa a partir do ambiente. Não lê disco. Não loga a chave.
 * DECUPA_COMPANY_API_KEY vence; senão valem ZAI_API_KEY / GEMINI_API_KEY /
 * MINIMAX_API_KEY / DECUPA_API_KEY, na mesma ordem do resolveProvider.
 */
export function companyCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Credentials | null {
  const companyKey = env.DECUPA_COMPANY_API_KEY?.trim();
  if (companyKey) {
    const presetRaw = (env.DECUPA_COMPANY_PRESET ?? "zai").trim();
    if (!isProvider(presetRaw)) {
      throw new Error(
        `DECUPA_COMPANY_PRESET aceita zai, gemini, minimax ou custom, não "${presetRaw}"`,
      );
    }
    const creds: Credentials = { preset: presetRaw, apiKey: companyKey };
    const model = env.DECUPA_COMPANY_MODEL?.trim() || env.DECUPA_MODEL?.trim();
    const baseUrl = env.DECUPA_COMPANY_BASE_URL?.trim() || env.DECUPA_BASE_URL?.trim();
    if (model) creds.model = model;
    if (baseUrl) creds.baseUrl = baseUrl;
    assertUsable(creds);
    return { ...creds, ...typeSafeFromEnv(env) };
  }
  try {
    const provider = resolveProvider(undefined, env);
    const cfg = presetConfig(provider, env);
    const apiKey = env[cfg.envKey]?.trim();
    if (!apiKey) return null;
    const creds: Credentials = { preset: provider, apiKey };
    if (provider === "custom") {
      creds.baseUrl = cfg.baseUrl;
      creds.model = cfg.model;
    }
    assertUsable(creds);
    return { ...creds, ...typeSafeFromEnv(env) };
  } catch (error) {
    if (error instanceof Error && /DECUPA_COMPANY_PRESET|HTTPS/.test(error.message)) throw error;
    return null;
  }
}

function assertUsable(creds: Credentials): void {
  const cfg = analysisClientOptions({ stored: creds, env: {} });
  const url = new URL(cfg.baseUrl!);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use um endpoint HTTPS sem credenciais ou parâmetros na URL.");
  }
}

/**
 * Grava `dir/.decupa/credentials` a partir do ambiente. Não sobrescreve
 * arquivo existente. Ausência de chave não é erro — a primeira abertura
 * continua pedindo o formulário.
 */
export async function installCompanyCredentials(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ status: "installed" | "skipped" | "absent" }> {
  const extra = typeSafeFromEnv(env);
  const existing = await readCredentials(dir);
  if (existing) {
    if (extra.typesafeApiKey && !existing.typesafeApiKey) {
      await writeCredentials(dir, { ...existing, ...extra });
      return { status: "installed" };
    }
    return { status: "skipped" };
  }
  const creds = companyCredentialsFromEnv(env);
  if (!creds) return { status: "absent" };
  await writeCredentials(dir, creds);
  return { status: "installed" };
}
