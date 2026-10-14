import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAiCompatClient } from "./openai-compat.ts";
import { ProviderHttpError } from "./openai-retry.ts";
import { OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS } from "./provider.ts";

const response = (content = "{}", finish = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }));
const opts = { apiKey: "fake", model: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1/chat/completions", profile: "openai-reasoning-medium" as const };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("envia o payload exato do Sol: medium, max_completion_tokens, store:false, json_object, sem max_tokens", async () => {
  let body: unknown;
  const fetchImpl = (async (_url, init) => { body = JSON.parse(String(init?.body)); return response(); }) as typeof fetch;
  const content = [{ type: "text", text: "proponha cenas" }];
  await new OpenAiCompatClient({ ...opts, maxTokens: 16_000, fetchImpl }).send(content);
  expect(body).toEqual({
    model: "gpt-6.1-sol", messages: [{ role: "user", content }],
    reasoning_effort: "medium", max_completion_tokens: 16_000, store: false, response_format: { type: "json_object" },
  });
  expect(body).not.toHaveProperty("max_tokens");
});

it.each([
  ["conteúdo cortado no teto", "{\"half\":true}"],
  ["raciocínio comeu o orçamento sem sobrar resposta", ""],
])("%s: dobra max_completion_tokens 16k→32k→64k e então recusa no teto", async (_label, truncatedContent) => {
  const bodies: Record<string, unknown>[] = [];
  let attempts = 0;
  const fetchImpl = (async (_url, init) => {
    attempts++;
    bodies.push(JSON.parse(String(init?.body)));
    return response(truncatedContent, "length");
  }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([])).rejects.toThrow(/Suba max_tokens/);
  expect(bodies.map(b => b.max_completion_tokens)).toEqual([16_000, 32_000, 64_000]);
  expect(attempts).toBe(3);
});

it("não repete HTTP permanente e preserva insufficient_quota sem retentativa", async () => {
  for (const status of [400, 401, 403]) {
    let attempts = 0;
    const fetchImpl = (async () => { attempts++; return new Response(JSON.stringify({ error: { code: "bad_request", message: "x" } }), { status }); }) as typeof fetch;
    const promise = new OpenAiCompatClient({ ...opts, retries: 20, fetchImpl }).send([]);
    await expect(promise).rejects.toMatchObject({ status, retryHandled: true });
    expect(attempts).toBe(1);
  }
  let quotaAttempts = 0;
  const quotaFetch = (async () => { quotaAttempts++; return new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "x" } }), { status: 429 }); }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, retries: 20, fetchImpl: quotaFetch }).send([])).rejects.toMatchObject({ status: 429, code: "insufficient_quota" });
  expect(quotaAttempts).toBe(1);
});

it("429/5xx retentam respeitando Retry-After, até o teto de tentativas HTTP", async () => {
  const times: number[] = [];
  const fetchImpl = (async () => {
    times.push(performance.now());
    return times.length === 1 ? new Response(JSON.stringify({ error: { code: "slow_down", message: "retry" } }), { status: 429, headers: { "Retry-After": "0.02" } }) : response();
  }) as typeof fetch;
  await new OpenAiCompatClient({ ...opts, fetchImpl }).send([]);
  expect(times.length).toBe(2);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(18);
});

it("limita tentativas HTTP mesmo com retries altos e devolve ProviderHttpError", async () => {
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; return new Response("not JSON", { status: 529, headers: { "Retry-After": "0" } }); }) as typeof fetch;
  const error = await new OpenAiCompatClient({ ...opts, retries: 50, fetchImpl }).send([]).catch(e => e as Error);
  expect(attempts).toBe(3);
  expect(error).toBeInstanceOf(ProviderHttpError);
});

it("cancelamento do usuário interrompe sem outra tentativa", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; setTimeout(() => controller.abort(), 10); return new Response("{}", { status: 429, headers: { "Retry-After": "10" } }); }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(attempts).toBe(1);
});

it.each([
  ["openai-reasoning-medium", "fetch"], ["openai-reasoning-medium", "already"],
  ["openai-reasoning-none", "fetch"], ["openai-reasoning-none", "already"],
] as const)("%s conserva AbortError com cancelamento %s", async (profile, when) => {
  const controller = new AbortController();
  let attempts = 0;
  if (when === "already") controller.abort();
  const fetchImpl = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    attempts++;
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    controller.abort();
  })) as typeof fetch;
  const error = await new OpenAiCompatClient({ ...opts, profile, fetchImpl }).send([], controller.signal).catch(error => error);
  expect(error).toBe(controller.signal.reason);
  expect(error.name).toBe("AbortError");
  expect(attempts).toBe(when === "already" ? 0 : 1);
});

it.each(["network", "timeout"])("repete uma falha transitória de %s", async kind => {
  let attempts = 0;
  const fetchImpl = (async () => {
    if (++attempts === 1) throw kind === "network" ? new TypeError("fetch failed") : new DOMException("expired", "TimeoutError");
    return response();
  }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([])).resolves.toBe("{}");
  expect(attempts).toBe(2);
});

it("401 redige a chave inteira e mascarada, sem ultrapassar 300 caracteres", async () => {
  const secret = "sk-fake-secret-do-not-log";
  const message = `Incorrect API key: ${secret}, ou sk-…abcd e sk-****abcd. ${"x".repeat(600)}`;
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message } }), { status: 401 })) as typeof fetch;
  const error = await new OpenAiCompatClient({ ...opts, apiKey: secret, fetchImpl }).send([]).catch(e => e as Error);
  expect(error).toBeInstanceOf(ProviderHttpError);
  if (!(error instanceof Error)) throw Error("deveria recusar a chave");
  expect(error.message).not.toContain(secret); expect(error.message).not.toContain("sk-");
  expect(error.message.length).toBeLessThanOrEqual(300);
});

it("escala o timeout por tentativa com o orçamento (300s→16k, 600s→32k, 1200s→64k), sob o mesmo teto total de 1.800.000 ms", async () => {
  const timeouts: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { timeouts.push(ms); return realTimeout(ms); });
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response("", "length"); }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([])).rejects.toThrow(/Suba max_tokens/);
  expect(bodies.map(b => b.max_completion_tokens)).toEqual([16_000, 32_000, 64_000]);
  // O primeiro valor é o teto total (budgetMs, fixo), e os três seguintes são
  // o timeout de cada tentativa individual (once()), um por orçamento.
  expect(timeouts[0]).toBe(OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS);
  expect(timeouts.slice(1)).toEqual([300_000, 600_000, 1_200_000]);
});

it("sucesso num orçamento maior usa o timeout por tentativa escalado (32k→600s), sem precisar do teto total", async () => {
  const timeouts: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { timeouts.push(ms); return realTimeout(ms); });
  const fetchImpl = (async () => response("{\"ok\":true}")) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, maxTokens: 32_000, fetchImpl }).send([])).resolves.toBe("{\"ok\":true}");
  expect(timeouts).toEqual([OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS, 600_000]);
});

it("timeout por tentativa do Sol nunca ultrapassa o teto total, mesmo com override maior", async () => {
  const timeouts: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { timeouts.push(ms); return realTimeout(ms); });
  const fetchImpl = (async () => response()) as typeof fetch;
  await new OpenAiCompatClient({ ...opts, timeoutMs: 2_000_000, fetchImpl }).send([]);
  expect(timeouts).toEqual([1_800_000, 1_800_000]);
});

it("o teto total (1.800.000 ms) cobre o envelope 120+240+480+480(compat JSON)+480(retry) segundos do texto de hoje", () => {
  expect(OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS).toBe(1_800_000);
  expect(OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS).toBeGreaterThanOrEqual((120 + 240 + 480 + 480 + 480) * 1000);
});

it("teto total do Sol é 1.800.000 ms, não o teto de 240 s do Luna", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("expired", "TimeoutError")), ms);
    return controller.signal;
  });
  let attempts = 0;
  const fetchImpl = ((_url, init) => new Promise<Response>((resolve, reject) => {
    attempts++;
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    // 150s + 150s = 300s de espera somada: já estouraria o teto antigo de
    // 240s do Luna, mas cabe dentro do teto de 1.800.000 ms do Sol.
    if (attempts === 1) setTimeout(() => resolve(new Response("{}", { status: 503, headers: { "Retry-After": "0" } })), 150_000);
    else setTimeout(() => resolve(response()), 150_000);
  })) as typeof fetch;
  const promise = new OpenAiCompatClient({ ...opts, fetchImpl }).send([]);
  const assertion = expect(promise).resolves.toBe("{}");
  await vi.advanceTimersByTimeAsync(150_000); await delay(5);
  await vi.advanceTimersByTimeAsync(150_000); await delay(5);
  expect(attempts).toBe(2);
  await assertion;
});

it("mensagem do teto esgotado identifica o texto da Montagem, não a visão", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("expired", "TimeoutError")), ms);
    return controller.signal;
  });
  const fetchImpl = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  const promise = new OpenAiCompatClient({ ...opts, timeoutMs: 1_000, fetchImpl }).send([]);
  const assertion = expect(promise).rejects.toMatchObject({ message: "texto da Montagem: tempo total de tentativas esgotado", retryHandled: true });
  await vi.advanceTimersByTimeAsync(OPENAI_ASSEMBLY_TEXT_TOTAL_TIMEOUT_MS); await delay(5);
  await assertion;
});
