import { describe, expect, it } from "vitest";
import { isRetryable, OpenAiCompatClient } from "./openai-compat.ts";

const body = (message: Record<string, unknown>, finish = "stop") => ({
  choices: [{ finish_reason: finish, index: 0, message }],
});

describe("isRetryable", () => {
  it("repete 503 e tempo esgotado, não 400", () => {
    expect(isRetryable(new Error("HTTP 503 de o provedor"))).toBe(true);
    expect(isRetryable(new Error("tempo esgotado depois de 20s esperando o provedor"))).toBe(true);
    expect(isRetryable(new Error("HTTP 400 de o provedor"))).toBe(false);
  });
});

describe("OpenAiCompatClient", () => {
  it("devolve o content de um 200", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body({ content: '{"ok":true}' })), { status: 200 })) as typeof fetch;
    const client = new OpenAiCompatClient({
      apiKey: "k", baseUrl: "https://example.test/v1/chat/completions", model: "m", fetchImpl,
    });
    await expect(client.send([{ type: "text", text: "oi" }])).resolves.toBe('{"ok":true}');
  });

  it("tenta de novo depois de um 503", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify(body({ content: '{"ok":true}' })), { status: 200 });
    }) as typeof fetch;
    const client = new OpenAiCompatClient({
      apiKey: "k", baseUrl: "https://example.test/v1", model: "m", fetchImpl,
    });
    await expect(client.send(["oi"])).resolves.toBe('{"ok":true}');
    expect(n).toBe(2);
  });

  it("não retenta HTTP 400", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;
    const client = new OpenAiCompatClient({
      apiKey: "k", baseUrl: "https://example.test/v1", model: "m", fetchImpl, retries: 2,
    });
    await expect(client.send(["oi"])).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });

  it("estoura no timeout", async () => {
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })) as unknown as typeof fetch;
    const client = new OpenAiCompatClient({
      apiKey: "k", baseUrl: "https://example.test/v1", model: "m",
      fetchImpl, timeoutMs: 20, retries: 0,
    });
    await expect(client.send(["oi"])).rejects.toThrow(/tempo esgotado/);
  });
});
