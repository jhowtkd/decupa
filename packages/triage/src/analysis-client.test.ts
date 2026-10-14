import { expect, it } from "vitest";
import { analysisClientOptions, assemblyTextClientOptions } from "./analysis-client.ts";
import { OPENAI_ASSEMBLY_TEXT_BASE, OPENAI_ASSEMBLY_TEXT_MODEL } from "./provider.ts";

// Credencial gravada com baseUrl é endpoint de outra pessoa: a chave do
// ambiente não pode ir junto. Sem rede — só a montagem das opções.
it("não envia a chave do ambiente para baseUrl gravado sem apiKey", () => {
  expect(() => analysisClientOptions({
    stored: { preset: "zai", baseUrl: "https://evil.example/v1" },
    env: { ZAI_API_KEY: "k" },
  })).toThrow(/apiKey/);
});

it("recusa baseUrl http mesmo com apiKey no arquivo", () => {
  expect(() => analysisClientOptions({
    stored: { preset: "zai", baseUrl: "http://evil.example/v1", apiKey: "k" },
    env: {},
  })).toThrow(/HTTPS/);
});

it("usa a apiKey do próprio arquivo quando o baseUrl HTTPS é o do arquivo", () => {
  const opts = analysisClientOptions({
    stored: { preset: "zai", baseUrl: "https://ok.example/v1", apiKey: "do-arquivo" },
    env: { ZAI_API_KEY: "do-env" },
  });
  expect(opts.apiKey).toBe("do-arquivo");
  expect(opts.baseUrl).toBe("https://ok.example/v1");
});

it("sem baseUrl, modelo gravado e chave do ambiente continuam valendo", () => {
  // GUIA §7: o arquivo vence o preset, e sem endpoint próprio a chave do
  // ambiente ainda autentica o host oficial.
  const opts = analysisClientOptions({
    stored: { preset: "zai", model: "x" },
    env: { ZAI_API_KEY: "k" },
  });
  expect(opts.apiKey).toBe("k");
  expect(opts.model).toBe("x");
});

const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };

it("assemblyTextClientOptions: selection 'text' é idêntico ao analysisClientOptions, sem o perfil medium", () => {
  const env = { DECUPA_ASSEMBLY_TEXT_PROVIDER: "text", OPENAI_API_KEY: "openai-fake" };
  expect(assemblyTextClientOptions({ stored: muse, env })).toEqual(analysisClientOptions({ stored: muse, env }));
  expect(assemblyTextClientOptions({ stored: muse, env }).profile).toBeUndefined();
});

it("assemblyTextClientOptions: selection 'openai' usa gpt-6.1-sol no perfil medium, chave do Luna, e o endpoint da visão", () => {
  const opts = assemblyTextClientOptions({ stored: muse, env: { OPENAI_API_KEY: "openai-fake" }, selection: { provider: "openai", source: "environment", configured: true, notice: null } });
  expect(opts).toMatchObject({ model: OPENAI_ASSEMBLY_TEXT_MODEL, baseUrl: OPENAI_ASSEMBLY_TEXT_BASE, profile: "openai-reasoning-medium", apiKey: "openai-fake", who: "a OpenAI" });
});

it("assemblyTextClientOptions: ambiente vence a credencial salva, e a chave do Muse nunca vai para a OpenAI", () => {
  const stored = { ...muse, openaiApiKey: "saved-openai" };
  expect(assemblyTextClientOptions({ stored, env: {}, selection: { provider: "openai", source: "credentials", configured: true, notice: null } }).apiKey).toBe("saved-openai");
  expect(assemblyTextClientOptions({ stored, env: { OPENAI_API_KEY: "env-openai" }, selection: { provider: "openai", source: "environment", configured: true, notice: null } }).apiKey).toBe("env-openai");
});

it("assemblyTextClientOptions: sem chave OpenAI e seleção 'openai', falha explícita (sem cair para o texto)", () => {
  expect(() => assemblyTextClientOptions({ stored: muse, env: {}, selection: { provider: "openai", source: "environment", configured: false, notice: null } }))
    .toThrow(/OPENAI_API_KEY/);
});

it("assemblyTextClientOptions: sem selection explícita, resolve pela função de escolha (padrão desligado continua no texto)", () => {
  expect(assemblyTextClientOptions({ stored: muse, env: {} }).apiKey).toBe("meta-fake");
  expect(assemblyTextClientOptions({ stored: muse, env: {} }).model).toBe(muse.model);
});
