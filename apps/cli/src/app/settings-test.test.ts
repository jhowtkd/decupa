import { afterEach, expect, it, vi } from "vitest";
import type { Credentials } from "@decupa/triage";
import { KEY_TEST_TIMEOUT_MS, NO_FREE_KEY_TEST, testProviderKey } from "./settings-test.ts";

afterEach(() => vi.restoreAllMocks());

const urls = (calls: Parameters<typeof fetch>[]) => calls.map(([url]) => String(url));

it("timeout curto fixo em cerca de 10s, sem retentativa", () => {
  expect(KEY_TEST_TIMEOUT_MS).toBe(10_000);
});

it("recusa seção fora de visual/openai/text/jev e campo não reconhecido, sem chamar fetch", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(testProviderKey({ section: "sol-direto" }, {}, null, fetchImpl)).rejects.toThrow();
  await expect(testProviderKey({ section: "visual", extra: 1 }, {}, null, fetchImpl)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("provedor de texto e Jev: sem chamada, desabilitado, mensagem fixa", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const section of ["text", "jev"]) {
    const result = await testProviderKey({ section }, {}, null, fetchImpl);
    expect(result).toEqual({ available: false, message: NO_FREE_KEY_TEST });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("OpenAI recusa preset/baseUrl/model escolhidos pelo navegador no teste", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(testProviderKey({ section: "visual", preset: "zai" }, {}, null, fetchImpl)).rejects.toThrow();
  await expect(testProviderKey({ section: "visual", baseUrl: "https://x" }, {}, null, fetchImpl)).rejects.toThrow();
  await expect(testProviderKey({ section: "visual", model: "m" }, {}, null, fetchImpl)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("sem nenhuma chave disponível, não chama rede e pede para configurar", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const result = await testProviderKey({ section: "visual" }, {}, null, fetchImpl);
  expect(result).toEqual({ available: true, source: "default", message: "Configure a chave OpenAI antes de testar.", models: [] });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("consulta os dois modelos oficiais, nunca /chat/completions, com Authorization e sem corpo/credencial no retorno", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "gpt-6-luna" }), { status: 200 }));
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
  expect(urls(calls as never)).toEqual(["https://api.openai.com/v1/models/gpt-6-luna", "https://api.openai.com/v1/models/gpt-6.1-sol"]);
  for (const [, init] of calls) {
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fake-openai-key-1234567890");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  expect(JSON.stringify(result)).not.toContain("fake-openai-key-1234567890");
  expect(JSON.stringify(result)).not.toContain("\"id\""); // nunca ecoa o corpo bruto do provedor
  expect(result).toEqual({ available: true, source: "input", message: "Chave funcionando", models: [
    { model: "gpt-6-luna", message: "Chave funcionando" }, { model: "gpt-6.1-sol", message: "Chave funcionando" },
  ] });
});

it("chave digitada tem prioridade sobre ambiente e credenciais; origem reportada é 'input'", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  await testProviderKey({ section: "visual", key: "typed-fake-key-1234567890" }, { OPENAI_API_KEY: "env-key" },
    { openaiApiKey: "stored-key" } as Credentials, fetchImpl);
  const auths = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => new Headers(init.headers).get("authorization"));
  expect(auths).toEqual(["Bearer typed-fake-key-1234567890", "Bearer typed-fake-key-1234567890"]);
});

it("sem chave digitada, usa o ambiente antes da credencial armazenada e relata a origem", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const result = await testProviderKey({ section: "visual" }, { OPENAI_API_KEY: "env-key" }, { openaiApiKey: "stored-key" } as Credentials, fetchImpl);
  const auths = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => new Headers(init.headers).get("authorization"));
  expect(auths).toEqual(["Bearer env-key", "Bearer env-key"]);
  expect(result.source).toBe("environment");
});

it("sem ambiente nem digitada, usa a credencial armazenada e relata a origem efetiva salva", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const result = await testProviderKey({ section: "visual" }, {}, { openaiApiKey: "stored-key", openaiApiKeySource: "project" } as unknown as Credentials, fetchImpl);
  const auths = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => new Headers(init.headers).get("authorization"));
  expect(auths).toEqual(["Bearer stored-key", "Bearer stored-key"]);
  expect(result.source).toBe("project");
});

it("200 nos dois modelos: Chave funcionando", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Chave funcionando");
});

it("404 num modelo só: aponta qual falta sem esconder o outro sucesso", async () => {
  let call = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: call++ === 0 ? 200 : 404 }));
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Sem acesso ao modelo gpt-6.1-sol");
  expect(result.models).toEqual([{ model: "gpt-6-luna", message: "Chave funcionando" }, { model: "gpt-6.1-sol", message: "Sem acesso ao modelo gpt-6.1-sol" }]);
});

it("401 e 403 nos dois modelos: chave recusada, sem duplicar a mensagem", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status }));
    const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
    expect(result.message).toBe("Chave recusada (401/403)");
  }
});

it("429 nos dois modelos: limite ou saldo", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 429 }));
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Limite ou saldo (429)");
});

it("falha de conexão (rejeição do fetch) cai na mensagem fixa de rede, sem detalhe do erro", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1"); });
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Não foi possível conectar");
  expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
});

it("abort/timeout e redirecionamento (rejeitado pelo fetch com redirect:'error') usam a mesma mensagem fixa de rede", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe("error");
    const error = new DOMException("The operation was aborted", "AbortError");
    throw error;
  });
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Não foi possível conectar");
});

it("status inesperado (nem 200/401/403/404/429) também cai na mensagem fixa de rede", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
  const result = await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Não foi possível conectar");
});

it("usa um único AbortSignal.timeout(10000) para as duas consultas, com redirect:'error' e sem retentativa mesmo em falha", async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => original(ms));
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("falha simulada"); });
  await testProviderKey({ section: "visual", key: "fake-openai-key-1234567890" }, {}, null, fetchImpl);
  expect(timeoutSpy).toHaveBeenCalledTimes(1); expect(timeoutSpy).toHaveBeenCalledWith(KEY_TEST_TIMEOUT_MS);
  expect(fetchImpl).toHaveBeenCalledTimes(2); // uma consulta por modelo, nenhuma repetição mesmo com falha
  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
  const signals = calls.map(([, init]) => init.signal);
  expect(signals[0]).toBeDefined(); expect(signals[0]).toBe(signals[1]); // mesmo sinal de timeout nas duas chamadas
  for (const [, init] of calls) expect(init.redirect).toBe("error");
});

it("mesmo em erro, nada vai para console.log/warn/error: nem a chave digitada, nem o corpo/erro fabricado", async () => {
  const spies = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("corpo remoto fabricado com secret-body-marker-998877 e a chave typed-console-leak-key-1234567890"); });
  const result = await testProviderKey({ section: "visual", key: "typed-console-leak-key-1234567890" }, {}, null, fetchImpl);
  expect(result.message).toBe("Não foi possível conectar");
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
