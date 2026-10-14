export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";

export const OPENAI_VISUAL_MODEL = "gpt-6-luna";
export const OPENAI_VISUAL_BASE = "https://api.openai.com/v1/chat/completions";
export const OPENAI_ASSEMBLY_TEXT_MODEL = "gpt-6.1-sol";
export const OPENAI_ASSEMBLY_TEXT_EFFORT = "medium";
export const OPENAI_ASSEMBLY_TEXT_BASE = OPENAI_VISUAL_BASE;
export const OPENAI_ASSEMBLY_TEXT_TIMEOUT_MS = 300_000;
// Comporta 120/240/480 s, a compatibilidade JSON e as retentativas do texto atual.
export const OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS = 1_800_000;

export type VisualProvider = "openai" | "text";
export type AssemblyTextProvider = "openai" | "text";
export type VisualSelection = {
  provider: VisualProvider;
  source: "environment" | "credentials" | "user" | "project" | "default" | "fallback";
  notice: string | null;
};
export const VISUAL_FALLBACK_NOTICE = "A análise de imagem está usando o provedor de texto. Configure a chave do GPT-6 Luna, mais rápido →";
export type AssemblyTextSelection = VisualSelection & { configured: boolean };
export const ASSEMBLY_TEXT_FALLBACK_NOTICE = "O texto da Montagem está usando o provedor de texto: falta a chave OpenAI para o GPT-6.1 Sol. Configure →";

/** Sol exige escolha explícita; ter a chave do Luna não autoriza texto na OpenAI. */
export function resolveAssemblyTextProvider(
  env: Record<string, string | undefined> = process.env,
  stored?: { openaiApiKey?: string; assemblyTextProvider?: AssemblyTextProvider;
    assemblyTextProviderSource?: "user" | "project" } | null,
): AssemblyTextSelection {
  const value = env.DECUPA_ASSEMBLY_TEXT_PROVIDER;
  if (value !== undefined && value !== "" && value !== "openai" && value !== "text") {
    throw new Error('DECUPA_ASSEMBLY_TEXT_PROVIDER aceita somente "openai" ou "text".');
  }
  const configured = Boolean(env.OPENAI_API_KEY?.trim() || stored?.openaiApiKey?.trim());
  // Um projeto recebido não autoriza enviar texto nem cobrar na conta do usuário.
  const saved = stored?.assemblyTextProviderSource === "project" && stored.assemblyTextProvider === "openai" ? undefined : stored?.assemblyTextProvider;
  const provider = value || saved || "text";
  const source = value ? "environment" : saved ? stored?.assemblyTextProviderSource ?? "credentials" : "default";
  if (!value && provider === "openai" && !configured) {
    return { provider: "text", source: "fallback", configured, notice: ASSEMBLY_TEXT_FALLBACK_NOTICE };
  }
  return { provider, source, configured, notice: null };
}

/** Só a visão usa esta escolha; texto e Jev conservam suas próprias chaves. */
export function resolveVisualProvider(
  env: Record<string, string | undefined> = process.env,
  stored?: { openaiApiKey?: string; visualProvider?: VisualProvider;
    openaiApiKeySource?: "user" | "project"; visualProviderSource?: "user" | "project" } | null,
): VisualSelection {
  const value = env.DECUPA_VISUAL_PROVIDER;
  if (value !== undefined && value !== "" && value !== "openai" && value !== "text") {
    throw new Error('DECUPA_VISUAL_PROVIDER aceita somente "openai" ou "text".');
  }
  if (value) return { provider: value, source: "environment", notice: null };
  if (stored?.visualProvider === "text") return { provider: "text", source: stored.visualProviderSource ?? "credentials", notice: null };
  if (env.OPENAI_API_KEY?.trim()) return { provider: "openai", source: "environment", notice: null };
  if (stored?.openaiApiKey?.trim()) return { provider: "openai", source: stored.visualProviderSource ?? stored.openaiApiKeySource ?? "credentials", notice: null };
  return { provider: "text", source: "fallback", notice: VISUAL_FALLBACK_NOTICE };
}

/**
 * A Z.ai serve dois endpoints quase idênticos que cobram de formas diferentes:
 * `/api/paas/v4` é pay-as-you-go e precisa de crédito pré-carregado, enquanto
 * `/api/coding/paas/v4` é a assinatura do Coding Plan.
 */
export const ZAI_DEFAULT_BASE = "https://api.z.ai/api/coding/paas/v4/chat/completions";

export type Provider = "zai" | "gemini" | "minimax" | "custom";

export type StoredProvider = {
  preset: Provider;
  model?: string;
  baseUrl?: string;
};

export const PRESETS: Record<Provider, { baseUrl: string; model: string; envKey: string }> = {
  zai: { baseUrl: ZAI_DEFAULT_BASE, model: ZAI_DEFAULT_MODEL, envKey: "ZAI_API_KEY" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    envKey: "GEMINI_API_KEY",
  },
  minimax: {
    baseUrl: "https://api.minimax.io/v1/chat/completions",
    model: "MiniMax-M2",
    envKey: "MINIMAX_API_KEY",
  },
  custom: { baseUrl: "", model: "", envKey: "DECUPA_API_KEY" },
};

const NAMES: Provider[] = ["zai", "gemini", "minimax", "custom"];

function isProvider(value: string): value is Provider {
  return (NAMES as string[]).includes(value);
}

/**
 * Qual motor de análise responde. Explícito > credentials do projeto > chave no env.
 */
export function resolveProvider(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
  stored?: StoredProvider | null,
): Provider {
  if (explicit !== undefined) {
    if (!isProvider(explicit)) {
      throw new Error(
        `--provider aceita "zai", "gemini", "minimax" ou "custom", não "${explicit}"`,
      );
    }
    return explicit;
  }
  if (stored?.preset && isProvider(stored.preset)) return stored.preset;
  if (env.ZAI_API_KEY) return "zai";
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.MINIMAX_API_KEY) return "minimax";
  if (env.DECUPA_API_KEY) return "custom";
  throw new Error(
    "nenhuma chave de análise no ambiente: ZAI_API_KEY, GEMINI_API_KEY, " +
    "MINIMAX_API_KEY ou DECUPA_API_KEY. Sem chave a triagem não roda — " +
    "monte o keep-list na mão e passe direto pro `condense.py plan`, que é o " +
    "caminho que o SKILL documenta.",
  );
}

export function presetConfig(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
  stored?: StoredProvider | null,
): { provider: Provider; baseUrl: string; model: string; envKey: string } {
  const preset = PRESETS[provider];
  const fromStore = stored?.preset === provider ? stored : null;
  const customEnv = provider === "custom";
  const baseUrl = fromStore?.baseUrl || (customEnv ? env.DECUPA_BASE_URL : undefined) || preset.baseUrl;
  const model = fromStore?.model || (customEnv ? env.DECUPA_MODEL : undefined) || preset.model;
  if (provider === "custom" && (!baseUrl || !model)) {
    throw new Error(
      "preset custom precisa de DECUPA_BASE_URL e DECUPA_MODEL (ou configure_provider com baseUrl e model)",
    );
  }
  return { provider, baseUrl, model, envKey: preset.envKey };
}
