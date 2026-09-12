import { expect, it } from "vitest";
import { ZaiClient } from "./zai-client.ts";

const body = (message: Record<string, unknown>, finish = "stop") => ({
  choices: [{ finish_reason: finish, index: 0, message }],
});

it("gemini usa a URL e a chave do Gemini, não a da Z.ai", async () => {
  let url = "";
  const fetchImpl = (async (input: string | URL) => {
    url = String(input);
    return new Response(JSON.stringify(body({ content: '{"ok":true}' })), { status: 200 });
  }) as typeof fetch;
  const client = new ZaiClient({
    provider: "gemini",
    env: { GEMINI_API_KEY: "g", ZAI_API_KEY: "z" },
    fetchImpl,
  });
  await client.send(["oi"]);
  expect(url).toContain("generativelanguage.googleapis.com");
});

it("send devolve o content e acumula usage", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    ...body({ content: '{"ok":true}', reasoning_content: "x" }),
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }))) as typeof fetch;
  const client = new ZaiClient({ apiKey: "k", fetchImpl });
  expect(await client.send([{ type: "text", text: "oi" }])).toBe('{"ok":true}');
  expect(client.usage()).toEqual({
    calls: 1, promptTokens: 10, completionTokens: 2, reasoningChars: 1,
  });
});

it("send para as chamadas seguintes quando o signal aborta", async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(JSON.stringify(body({ content: '{"ok":true}' })));
  }) as typeof fetch;
  const client = new ZaiClient({ apiKey: "k", fetchImpl, retries: 0, timeoutMs: 5_000 });
  const ac = new AbortController();
  const pending = client.send([{ type: "text", text: "oi" }], ac.signal);
  ac.abort();
  await expect(pending).rejects.toThrow();
  expect(calls).toBe(1);
});
