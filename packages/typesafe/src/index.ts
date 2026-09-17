import { createTracer, type Tracer } from "@decupa/trace";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";
export const TYPESAFE_ENV_KEY = "TYPESAFE_API_KEY";

/** Corte só acima de um empate; 0.51 nunca autoriza. */
export const CUT_NOUL_MIN = 0.51;

const DEFAULT_RETRY_BUDGET_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_JITTER = 0.25;
const RETRYABLE = new Set([429, 529]);
const NO_RETRY = new Set([401, 422]);

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type TypeSafeQuestion = ChoiceQuestion | NoulQuestion;

export type TypeSafeRequest = {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  model?: string;
};

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type TypeSafeAnswer = ChoiceAnswer | NoulAnswer;

export type TypeSafeResult = {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
};

export type TypeSafeClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  model?: string;
  tracer?: Tracer;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retryBudgetMs?: number;
  maxRetries?: number;
};

export class TypeSafeHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "TypeSafeHttpError";
    this.status = status;
  }
}

export function isTypeSafeEnabled(
  _env: Record<string, string | undefined> = process.env,
): boolean {
  return false;
}

export function authorizesCut(noul: number): boolean {
  return Number.isFinite(noul) && noul > CUT_NOUL_MIN && noul <= 1;
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function backoffMs(attempt: number, random: () => number): number {
  const base = BACKOFF_INITIAL_MS * 2 ** attempt;
  return base * (1 - random() * BACKOFF_JITTER);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class TypeSafeClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly tracer: Tracer;
  private readonly logLine?: (line: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly retryBudgetMs: number;
  private readonly maxRetries: number;

  constructor(opts: TypeSafeClientOptions) {
    if (!opts.apiKey) {
      throw new Error("TYPESAFE_API_KEY ausente. O adaptador TypeSafe não chama a API sem chave.");
    }
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? TYPESAFE_ENDPOINT;
    this.model = opts.model ?? TYPESAFE_DEFAULT_MODEL;
    this.tracer = opts.tracer ?? createTracer();
    this.logLine = opts.log;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = opts.random ?? Math.random;
    this.retryBudgetMs = opts.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private redact(text: string): string {
    return redactSecrets(text, [this.apiKey]);
  }

  private note(line: string): void {
    try {
      this.logLine?.(this.redact(line));
    } catch {
      // Falha de log nunca vaza segredo nem interrompe a decisão.
    }
  }

  async decide(req: TypeSafeRequest, signal?: AbortSignal): Promise<TypeSafeResult> {
    return this.tracer.run("typesafe", () => this.decideWithRetry(req, signal), { signal });
  }

  private async decideWithRetry(req: TypeSafeRequest, signal?: AbortSignal): Promise<TypeSafeResult> {
    const startedAt = this.now();
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(req, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        const status = err instanceof TypeSafeHttpError ? err.status : 0;
        if (NO_RETRY.has(status) || !RETRYABLE.has(status) || attempt >= this.maxRetries) throw err;
        const delay = backoffMs(attempt, this.random);
        const elapsed = Math.max(0, this.now() - startedAt);
        if (elapsed + delay >= this.retryBudgetMs) throw err;
        this.note(`HTTP ${status}; retry in ${delay}ms`);
        await this.sleep(delay);
        attempt += 1;
      }
    }
  }

  private async once(req: TypeSafeRequest, signal?: AbortSignal): Promise<TypeSafeResult> {
    const payload = {
      state: req.state,
      model: req.model ?? this.model,
      questions: req.questions,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(this.redact(err instanceof Error ? err.message : String(err)));
    }

    const raw = this.redact(await res.text());
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!res.ok) throw new TypeSafeHttpError(res.status, raw.slice(0, 200));
      throw new Error("resposta TypeSafe não é JSON");
    }
    if (!res.ok) {
      const rec = asRecord(parsed);
      const detail = this.redact(typeof rec?.error === "string" ? rec.error : raw.slice(0, 200));
      this.note(`HTTP ${res.status}: ${detail}`);
      throw new TypeSafeHttpError(res.status, detail);
    }
    return parseResult(parsed, req.questions);
  }
}

function parseResult(
  raw: unknown,
  questions: Record<string, TypeSafeQuestion>,
): TypeSafeResult {
  const rec = asRecord(raw);
  if (!rec) throw new Error("resposta TypeSafe inválida");
  const answersRaw = asRecord(rec.answers);
  if (!answersRaw) throw new Error("resposta TypeSafe sem answers");
  const answers: Record<string, TypeSafeAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    answers[name] = parseAnswer(name, question, answersRaw[name]);
  }
  const result: TypeSafeResult = {
    model: typeof rec.model === "string" ? rec.model : TYPESAFE_DEFAULT_MODEL,
    answers,
  };
  const usage = asRecord(rec.usage);
  if (usage && Number.isFinite(Number(usage.input_tokens)) && Number.isFinite(Number(usage.output_tokens))) {
    result.usage = {
      input_tokens: Number(usage.input_tokens),
      output_tokens: Number(usage.output_tokens),
    };
  }
  return result;
}

function parseAnswer(name: string, question: TypeSafeQuestion, raw: unknown): TypeSafeAnswer {
  const rec = asRecord(raw);
  if (!rec) throw new Error(`resposta TypeSafe sem answer para ${name}`);
  if (question.type === "noul") {
    const noul = rec.noul;
    if (!isProbability(noul)) throw new Error(`probabilidade inválida em ${name}`);
    return { type: "noul", noul };
  }
  const choice = rec.choice;
  if (typeof choice !== "string" || !(choice in question.criteria)) {
    throw new Error(`escolha inventada fora do critério em ${name}`);
  }
  const probabilitiesRaw = asRecord(rec.probabilities) ?? {};
  const probabilities: Record<string, number> = {};
  for (const option of Object.keys(question.criteria)) {
    const value = probabilitiesRaw[option];
    if (!isProbability(value)) throw new Error(`probabilidade inválida em ${name}`);
    probabilities[option] = value;
  }
  const confidence = rec.confidence;
  if (!isProbability(confidence)) throw new Error(`probabilidade inválida em ${name}`);
  return { type: "choice", choice, probabilities, confidence };
}
