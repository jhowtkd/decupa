import {
  redactSecrets,
  TypeSafeClient,
  TypeSafeHttpError,
  TYPESAFE_DEFAULT_MODEL,
} from "./index.ts";

export type DecisionMode = "off" | "observe" | "hybrid";

export class DecisionConfigError extends Error {
  readonly name = "DecisionConfigError";
}

export type DecisionConfig = {
  mode: DecisionMode;
  model: string;
  enabled: boolean;
};

export type DecisionBoot = {
  mode: DecisionMode;
  enabled: boolean;
  apiCalls: number;
  fallback: "off" | "observe" | "unauthorized" | "unavailable" | null;
};

export function parseDecisionConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): DecisionConfig {
  if (raw == null) {
    return { mode: "off", model: TYPESAFE_DEFAULT_MODEL, enabled: false };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionConfigError("config de decisão inválida");
  }
  const rec = raw as Record<string, unknown>;
  const mode = rec.mode;
  if (mode !== "off" && mode !== "observe" && mode !== "hybrid") {
    throw new DecisionConfigError(`modo de decisão inválido: ${String(mode)}`);
  }
  const model = typeof rec.model === "string" && rec.model.length > 0
    ? rec.model
    : TYPESAFE_DEFAULT_MODEL;
  const enabled = mode === "hybrid"
    && Boolean(env.TYPESAFE_API_KEY)
    && env.DECUPA_TYPESAFE === "1";
  return { mode, model, enabled };
}

export function decisionLogLine(opts: {
  provider: string;
  model: string;
  elapsedMs: number;
  fallback: boolean | string;
  apiKey?: string;
  content?: string;
}): string {
  const line = `provider=${opts.provider} model=${opts.model} elapsedMs=${opts.elapsedMs} fallback=${opts.fallback}`;
  return redactSecrets(line, opts.apiKey ? [opts.apiKey] : []);
}

export async function bootDecision(opts: {
  config: DecisionConfig;
  fetchImpl?: typeof fetch;
  apiKey?: string;
}): Promise<DecisionBoot> {
  if (opts.config.mode === "off") {
    return { mode: "off", enabled: false, apiCalls: 0, fallback: "off" };
  }
  if (opts.config.mode === "observe" || !opts.config.enabled) {
    return {
      mode: opts.config.mode,
      enabled: false,
      apiCalls: 0,
      fallback: opts.config.mode === "observe" ? "observe" : "off",
    };
  }
  if (!opts.apiKey || !opts.fetchImpl) {
    return { mode: "hybrid", enabled: false, apiCalls: 0, fallback: "unauthorized" };
  }
  const client = new TypeSafeClient({
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    model: opts.config.model,
  });
  try {
    await client.decide({
      state: { ping: true },
      model: opts.config.model,
      questions: {
        ready: { type: "noul", instructions: "Is the decision adapter reachable?" },
      },
    });
    return { mode: "hybrid", enabled: true, apiCalls: 1, fallback: null };
  } catch (error) {
    const status = error instanceof TypeSafeHttpError ? error.status : 0;
    const fallback = status === 401 || status === 422 ? "unauthorized" : "unavailable";
    return { mode: "hybrid", enabled: false, apiCalls: 1, fallback };
  }
}
