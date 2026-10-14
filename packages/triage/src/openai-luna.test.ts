import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAiCompatClient } from "./openai-compat.ts";
import { ProviderHttpError, retryAfterMs } from "./openai-retry.ts";
import { isVisualRetryable } from "../../../apps/cli/src/app/assembly/visual-pool.ts";

const response = (content = "{}", finish = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }));
const opts = { apiKey: "fake", model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1/chat/completions", profile: "openai-reasoning-none" as const };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("envia o payload Luna exato sem mutar os fotogramas recebidos", async () => {
  let body: unknown;
  const fetchImpl = (async (_url, init) => { body = JSON.parse(String(init?.body)); return response(); }) as typeof fetch;
  const content = [{ type: "text", text: "Retorne JSON" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }];
  await new OpenAiCompatClient({ ...opts, maxTokens: 123, jsonObject: false, fetchImpl }).send(content);
  expect(body).toEqual({ model: "gpt-6-luna", messages: [{ role: "user", content: [content[0], { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==", detail: "auto" } }] }], reasoning_effort: "none", max_completion_tokens: 123, store: false, response_format: { type: "json_object" } });
  expect(content[1]!.image_url).not.toHaveProperty("detail");
});
it("preserva o payload do Muse byte a byte e não infere perfil pelo modelo", async () => {
  const payloads: string[] = [];
  const fetchImpl = (async (_url, init) => { payloads.push(String(init?.body)); return response(); }) as typeof fetch;
  const content = [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }, { type: "text", text: "JSON" }];
  for (const model of ["muse-spark-1.3-contributor", "gpt-6-luna"]) {
    await new OpenAiCompatClient({ ...opts, model, profile: "default", fetchImpl }).send(content);
    expect(payloads.at(-1)).toBe(JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 16000, response_format: { type: "json_object" } }));
  }
});
it.each(["{\"half\":true}", ""])("truncamento %s é recusado sem crescimento de orçamento", async content => {
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; return response(content, "length"); }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([])).rejects.toThrow(/Suba max_tokens/);
  expect(attempts).toBe(1);
});
it.each([400, 401, 403, 429])("preserva HTTP %s e não repete erros permanentes/quota", async status => {
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; return new Response(JSON.stringify({ error: { code: status === 429 ? "insufficient_quota" : "bad_request", message: "response_format rejected" } }), { status }); }) as typeof fetch;
  const promise = new OpenAiCompatClient({ ...opts, retries: 20, fetchImpl }).send([]);
  await expect(promise).rejects.toMatchObject({ status, code: status === 429 ? "insufficient_quota" : "bad_request", retryHandled: true });
  expect(attempts).toBe(1);
});
it("respeita Retry-After em segundos e guarda tentativas HTTP", async () => {
  const times: number[] = [];
  let counted = 0;
  const fetchImpl = (async () => { times.push(performance.now()); return times.length === 1 ? new Response(JSON.stringify({ error: { code: "slow_down", message: "retry" } }), { status: 429, headers: { "Retry-After": "0.02" } }) : response(); }) as typeof fetch;
  await new OpenAiCompatClient({ ...opts, fetchImpl }).send([], undefined, () => { counted++; });
  expect(counted).toBe(2);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(18);
});
it("Retry-After aceita datas e não cabe além do teto total", async () => {
  expect(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"))).toBe(2000);
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; return new Response("{}", { status: 503, headers: { "Retry-After": "241" } }); }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([])).rejects.toMatchObject({ status: 503 });
  expect(attempts).toBe(1);
});
it("limita tentativas e não deixa o pool repetir o transporte esgotado", async () => {
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; return new Response("not JSON", { status: 529, headers: { "Retry-After": "0" } }); }) as typeof fetch;
  let error: unknown;
  try { await new OpenAiCompatClient({ ...opts, retries: 50, fetchImpl }).send([]); } catch (e) { error = e; }
  expect(attempts).toBe(3);
  expect(error).toBeInstanceOf(ProviderHttpError);
  expect(isVisualRetryable(error)).toBe(false);
});
it("cancelamento interrompe a espera sem outra tentativa", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; setTimeout(() => controller.abort(), 10); return new Response("{}", { status: 429, headers: { "Retry-After": "10" } }); }) as typeof fetch;
  await expect(new OpenAiCompatClient({ ...opts, fetchImpl }).send([], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(attempts).toBe(1);
});

it.each([true, false])("401 omite chave inteira e mascarada (JSON=%s)", async json => {
  const secret = "sk-fake-secret-do-not-log";
  const message = `Incorrect API key: ${secret}, ou sk-…abcd e sk-****abcd. ${"x".repeat(600)}`;
  const fetchImpl = (async () => new Response(json ? JSON.stringify({ error: { code: "invalid_api_key", message } }) : message, { status: 401 })) as typeof fetch;
  const error = await new OpenAiCompatClient({ ...opts, apiKey: secret, fetchImpl }).send([]).catch(e => e as Error);
  expect(error).toBeInstanceOf(ProviderHttpError);
  if (!(error instanceof Error)) throw Error("deveria recusar a chave");
  expect(error.message).not.toContain(secret); expect(error.message).not.toContain("sk-");
  expect(error.message.length).toBeLessThanOrEqual(300);
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

it("teto total soma tentativas e interrompe a segunda antes do seu timeout individual", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("expired", "TimeoutError")), ms);
    return controller.signal;
  });
  let attempts = 0;
  const fetchImpl = (( _url, init) => new Promise<Response>((resolve, reject) => {
    attempts++;
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    if (attempts === 1) setTimeout(() => resolve(new Response("{}", { status: 503, headers: { "Retry-After": "0" } })), 110_000);
  })) as typeof fetch;
  const promise = new OpenAiCompatClient({ ...opts, timeoutMs: 150_000, fetchImpl }).send([]);
  const assertion = expect(promise).rejects.toMatchObject({ message: "visão: tempo total de tentativas esgotado", retryHandled: true });
  await vi.advanceTimersByTimeAsync(110_000); await delay(5);
  expect(attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(130_000); await assertion;
  expect(attempts).toBe(2);
});
