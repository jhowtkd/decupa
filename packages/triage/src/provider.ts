export const ZAI_DEFAULT_MODEL = "glm-5.3-flash";

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
