import { expect, it } from "vitest";
import { analysisClientOptions } from "./analysis-client.ts";

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
