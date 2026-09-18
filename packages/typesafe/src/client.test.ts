import { describe, expect, it } from "vitest";
import { collectSink, createTracer } from "@decupa/trace";
import {
  authorizesCut,
  isTypeSafeEnabled,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_ENDPOINT,
  TypeSafeClient,
  type TypeSafeClientOptions,
  type TypeSafeQuestion,
} from "./index.ts";

type ClientHarness = Omit<TypeSafeClientOptions, "apiKey" | "fetchImpl">;

const KEY = "sk-typesafe-secret-do-not-log";

const questions: Record<string, TypeSafeQuestion> = {
  cut: {
    type: "noul",
    instructions: "Should this unit be cut from the keep list?",
  },
  action: {
    type: "choice",
    instructions: "Which edit action applies?",
    criteria: {
      drop: "Remove the claimed units",
      keep: "Leave the units in the keep list",
      review: "Send to human review",
    },
  },
};

function jsonResponse(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function noulOk(noul: number) {
  return {
    model: "jev-1.13.0",
    answers: {
      cut: { type: "noul", noul },
      action: {
        type: "choice",
        choice: "keep",
        probabilities: { drop: 0.1, keep: 0.8, review: 0.1 },
        confidence: 0.7,
      },
    },
    usage: { input_tokens: 12, output_tokens: 4 },
  };
}

function client(fetchImpl: typeof fetch, extra: ClientHarness = {}) {
  return new TypeSafeClient({ ...extra, apiKey: KEY, fetchImpl });
}

describe("isTypeSafeEnabled", () => {
  it("fica desligado no modo padrão, mesmo com chave no ambiente", () => {
    expect(isTypeSafeEnabled({})).toBe(false);
    expect(isTypeSafeEnabled({ TYPESAFE_API_KEY: KEY })).toBe(false);
    expect(isTypeSafeEnabled({ TYPESAFE_API_KEY: KEY, DECUPA_TYPESAFE: "0" })).toBe(false);
  });
});

describe("TypeSafeClient payload", () => {
  it("POSTa o contrato SystemOne com Bearer e modelo jev-latest", async () => {
    let url = "";
    let method = "";
    let headers: Headers | undefined;
    let payload: Record<string, unknown> = {};
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      url = String(input);
      method = init?.method ?? "";
      headers = new Headers(init?.headers);
      payload = JSON.parse(String(init?.body));
      return jsonResponse(noulOk(0.12));
    }) as typeof fetch;

    const result = await client(fetchImpl).decide({
      state: { unitId: "u003", transcript: "então, tipo, vamos começar" },
      questions,
    });

    expect(url).toBe(TYPESAFE_ENDPOINT);
    expect(method).toBe("POST");
    expect(headers?.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(headers?.get("Content-Type")).toBe("application/json");
    expect(payload).toEqual({
      state: { unitId: "u003", transcript: "então, tipo, vamos começar" },
      model: TYPESAFE_DEFAULT_MODEL,
      questions,
    });
    expect(result.answers.cut).toEqual({ type: "noul", noul: 0.12 });
    expect(result.answers.action).toMatchObject({ type: "choice", choice: "keep" });
  });
});

describe("segredos fora dos logs", () => {
  it("nunca inclui a chave em erros, logs ou traços", async () => {
    const logs: string[] = [];
    const sink = collectSink();
    const fetchImpl = (async () => jsonResponse({ error: `bad key ${KEY}` }, 401)) as typeof fetch;
    const ts = client(fetchImpl, {
      tracer: createTracer(sink),
      log: (line) => logs.push(line),
    });

    await expect(ts.decide({ state: "segredo da transcrição privada", questions })).rejects.toThrow(/401/);
    const blob = `${logs.join("\n")}\n${JSON.stringify(sink.events)}`;
    expect(blob).not.toContain(KEY);
    expect(blob).not.toContain("segredo da transcrição");
    expect(sink.events.every((e) => !("state" in e) && !("apiKey" in e))).toBe(true);
  });
});

describe("retries", () => {
  it("401 e 422 não tentam de novo", async () => {
    for (const status of [401, 422]) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return jsonResponse({ error: "no" }, status);
      }) as typeof fetch;
      await expect(client(fetchImpl).decide({ state: "x", questions })).rejects.toThrow(String(status));
      expect(calls).toBe(1);
    }
  });

  it("429 e 529 repetem com jitter dentro do orçamento", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "slow" }, 429);
      if (calls === 2) return jsonResponse({ error: "busy" }, 529);
      return jsonResponse(noulOk(0.2));
    }) as typeof fetch;

    const result = await client(fetchImpl, {
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
      retryBudgetMs: 30_000,
      maxRetries: 2,
    }).decide({ state: "x", questions });

    expect(result.answers.cut).toMatchObject({ noul: 0.2 });
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(437.5);
    expect(sleeps[1]).toBe(875);
  });

  it("não espera um backoff que estouraria o orçamento", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({ error: "slow" }, 429);
    }) as typeof fetch;

    await expect(client(fetchImpl, {
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
      retryBudgetMs: 100,
      maxRetries: 4,
    }).decide({ state: "x", questions })).rejects.toThrow(/429/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("validação das respostas", () => {
  it("rejeita escolha inventada fora do critério", async () => {
    const fetchImpl = (async () => jsonResponse({
      model: "jev-latest",
      answers: {
        cut: { type: "noul", noul: 0.1 },
        action: {
          type: "choice",
          choice: "delete_forever",
          probabilities: { drop: 0.2, keep: 0.2, review: 0.2, delete_forever: 0.4 },
          confidence: 0.3,
        },
      },
    })) as typeof fetch;
    await expect(client(fetchImpl).decide({ state: "x", questions })).rejects.toThrow(/inventad|escolha|critério/i);
  });

  it("rejeita probabilidade inválida", async () => {
    for (const noul of [Number.NaN, -0.1, 1.2, Number.POSITIVE_INFINITY]) {
      const fetchImpl = (async () => jsonResponse({
        model: "jev-latest",
        answers: {
          cut: { type: "noul", noul },
          action: {
            type: "choice",
            choice: "keep",
            probabilities: { drop: 0.1, keep: 0.8, review: 0.1 },
            confidence: 0.7,
          },
        },
      })) as typeof fetch;
      await expect(client(fetchImpl).decide({ state: "x", questions })).rejects.toThrow(/probabilidade/i);
    }
  });

  it("rejeita probabilidade inválida na escolha sem retry", async () => {
    const cases: { probabilities?: Record<string, number>; confidence?: number }[] = [
      { probabilities: { drop: 0.1, keep: 1.2, review: 0.1 }, confidence: 0.7 },
      { probabilities: { drop: 0.1, keep: 0.8, review: 0.1 }, confidence: Number.NaN },
    ];
    for (const broken of cases) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return jsonResponse({
          model: "jev-latest",
          answers: {
            cut: { type: "noul", noul: 0.2 },
            action: {
              type: "choice",
              choice: "keep",
              probabilities: broken.probabilities ?? { drop: 0.1, keep: 0.8, review: 0.1 },
              confidence: broken.confidence ?? 0.7,
            },
          },
        });
      }) as typeof fetch;
      await expect(client(fetchImpl).decide({ state: "x", questions })).rejects.toThrow(/probabilidade/i);
      expect(calls).toBe(1);
    }
  });
});

describe("authorizesCut", () => {
  it("0.51 nunca autoriza corte", () => {
    expect(authorizesCut(0.51)).toBe(false);
    expect(authorizesCut(0.5)).toBe(false);
    expect(authorizesCut(0)).toBe(false);
    expect(authorizesCut(0.9)).toBe(true);
  });
});
