import { describe, expect, it } from "vitest";
import { TYPESAFE_DEFAULT_MODEL, TypeSafeHttpError } from "./index.ts";
import {
  DecisionConfigError,
  bootDecision,
  decisionLogLine,
  parseDecisionConfig,
} from "./config.ts";

const KEY = "sk-typesafe-secret-do-not-log";

describe("parseDecisionConfig", () => {
  it("config ausente abre com a feature desligada", () => {
    expect(parseDecisionConfig(null)).toEqual({
      mode: "off",
      model: TYPESAFE_DEFAULT_MODEL,
      enabled: false,
    });
    expect(parseDecisionConfig(undefined, { TYPESAFE_API_KEY: KEY, DECUPA_TYPESAFE: "1" })).toEqual({
      mode: "off",
      model: TYPESAFE_DEFAULT_MODEL,
      enabled: false,
    });
  });

  it("recusa modo inválido", () => {
    expect(() => parseDecisionConfig({ mode: "full" })).toThrow(DecisionConfigError);
    expect(() => parseDecisionConfig({ mode: "full" })).toThrow(/inválido/);
  });

  it("hybrid sem opt-in ou sem chave permanece desligado", () => {
    expect(parseDecisionConfig({ mode: "hybrid" }, { TYPESAFE_API_KEY: KEY }).enabled).toBe(false);
    expect(parseDecisionConfig({ mode: "hybrid", model: "jev-latest" }, { DECUPA_TYPESAFE: "1" }).enabled).toBe(false);
    expect(parseDecisionConfig(
      { mode: "hybrid" },
      { TYPESAFE_API_KEY: KEY, DECUPA_TYPESAFE: "1" },
    )).toEqual({ mode: "hybrid", model: TYPESAFE_DEFAULT_MODEL, enabled: true });
  });
});

describe("bootDecision", () => {
  it("observe não consome API ao abrir o app", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("observe não chama TypeSafe");
    }) as typeof fetch;
    const boot = await bootDecision({
      config: parseDecisionConfig({ mode: "observe" }, { TYPESAFE_API_KEY: KEY }),
      fetchImpl,
    });
    expect(boot.apiCalls).toBe(0);
    expect(calls).toBe(0);
    expect(boot.mode).toBe("observe");
  });

  it("API não autorizada não liga o Jev", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 })) as typeof fetch;
    const boot = await bootDecision({
      config: parseDecisionConfig({ mode: "hybrid" }, { TYPESAFE_API_KEY: KEY, DECUPA_TYPESAFE: "1" }),
      fetchImpl,
      apiKey: KEY,
    });
    expect(boot.enabled).toBe(false);
    expect(boot.fallback).toBe("unauthorized");
  });

  it("modelo indisponível cai em fallback sem conteúdo", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "missing model" }), { status: 404 })) as typeof fetch;
    const boot = await bootDecision({
      config: parseDecisionConfig({ mode: "hybrid", model: "jev-ausente" }, { TYPESAFE_API_KEY: KEY, DECUPA_TYPESAFE: "1" }),
      fetchImpl,
      apiKey: KEY,
    });
    expect(boot.enabled).toBe(false);
    expect(boot.fallback).toBe("unavailable");
    expect(JSON.stringify(boot)).not.toContain(KEY);
  });

  it("desligamento mantém modo off", async () => {
    const boot = await bootDecision({
      config: parseDecisionConfig({ mode: "off" }, { TYPESAFE_API_KEY: KEY, DECUPA_TYPESAFE: "1" }),
      fetchImpl: (async () => {
        throw new Error("off não chama");
      }) as typeof fetch,
    });
    expect(boot.mode).toBe("off");
    expect(boot.enabled).toBe(false);
    expect(boot.apiCalls).toBe(0);
  });
});

describe("decisionLogLine", () => {
  it("redige a chave e não inclui conteúdo editorial", () => {
    const line = decisionLogLine({
      provider: "typesafe",
      model: "jev-latest",
      elapsedMs: 12,
      fallback: true,
      apiKey: KEY,
      content: "corte u001 porque o cliente errou",
    });
    expect(line).toContain("provider=typesafe");
    expect(line).toContain("model=jev-latest");
    expect(line).toContain("elapsedMs=12");
    expect(line).toContain("fallback=true");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("u001");
    expect(line).not.toContain("cliente");
  });
});

describe("TypeSafeHttpError", () => {
  it("401 não é retryable no adaptador", () => {
    const err = new TypeSafeHttpError(401, "nope");
    expect(err.status).toBe(401);
  });
});
