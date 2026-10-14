import { expect, it } from "vitest";
import { analysisClientOptions, createVisualClient, visualClientOptions } from "./analysis-client.ts";
import { OPENAI_VISUAL_BASE, resolveVisualProvider, VISUAL_FALLBACK_NOTICE } from "./provider.ts";
import { payloadProfileKey } from "./payload-profile.ts";

const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
const lunar = { DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "openai-fake" };
it("Luna é o padrão com chave; fallback conserva o texto", () => {
  expect(resolveVisualProvider({})).toEqual({ provider: "text", source: "fallback", notice: VISUAL_FALLBACK_NOTICE });
  expect(resolveVisualProvider({ OPENAI_API_KEY: "fake" })).toEqual({ provider: "openai", source: "environment", notice: null });
  expect(visualClientOptions({ stored: muse, env: { OPENAI_API_KEY: "fake" } }).model).toBe("gpt-6-luna");
  expect(resolveVisualProvider(lunar)).toEqual({ provider: "openai", source: "environment", notice: null });
  expect(() => resolveVisualProvider({ DECUPA_VISUAL_PROVIDER: "typo" })).toThrow(/DECUPA_VISUAL_PROVIDER/);
});
it.each([
  [{ DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "fake" }, {}, "openai", "environment", false],
  [{ DECUPA_VISUAL_PROVIDER: "openai" }, {}, "openai", "environment", false],
  [{ DECUPA_VISUAL_PROVIDER: "text", OPENAI_API_KEY: "fake" }, {}, "text", "environment", false],
  [{}, { visualProvider: "text", openaiApiKey: "fake" }, "text", "credentials", false],
  [{}, { openaiApiKey: "fake" }, "openai", "credentials", false],
  [{}, { visualProvider: "openai" }, "text", "fallback", true],
  [{ OPENAI_API_KEY: " " }, {}, "text", "fallback", true],
] as const)("resolve a tabela de escolha %j / %j", (env, stored, provider, source, notice) => {
  expect(resolveVisualProvider(env, stored)).toMatchObject({ provider, source, notice: notice ? VISUAL_FALLBACK_NOTICE : null });
});
it("ambiente vence a chave salva e nenhum segredo cruza para o texto", () => {
  const stored = { ...muse, openaiApiKey: "saved-openai" };
  expect(visualClientOptions({ stored, env: {} })).toMatchObject({ apiKey: "saved-openai", baseUrl: OPENAI_VISUAL_BASE });
  expect(visualClientOptions({ stored, env: { OPENAI_API_KEY: "env-openai" } }).apiKey).toBe("env-openai");
  expect(analysisClientOptions({ stored, env: { OPENAI_API_KEY: "env-openai" } }).apiKey).toBe("meta-fake");
  expect(visualClientOptions({ stored, env: { DECUPA_VISUAL_PROVIDER: "text" } }).apiKey).toBe("meta-fake");
});
it("chave da visão é exclusiva e sua ausência não impede texto", () => {
  expect(() => visualClientOptions({ stored: muse, env: { DECUPA_VISUAL_PROVIDER: "openai" } })).toThrow(/OPENAI_API_KEY/);
  expect(analysisClientOptions({ stored: muse, env: lunar }).apiKey).toBe("meta-fake");
  expect(visualClientOptions({ stored: muse, env: lunar }).apiKey).toBe("openai-fake");
});
it("overrides de teste vencem o ambiente e endpoint salvo mantém vínculo com sua chave", () => {
  expect(visualClientOptions({ apiKey: "fixture", model: "test", baseUrl: "https://fixture.test", env: lunar }).model).toBe("test");
  expect(() => visualClientOptions({ stored: { preset: "custom", model: "m", baseUrl: "https://evil.test" }, env: { DECUPA_API_KEY: "secret" } })).toThrow(/apiKey/);
  expect(() => visualClientOptions({ stored: { ...muse, baseUrl: "http://evil.test" }, env: {} })).toThrow(/HTTPS/);
});
it("a chave não altera a identidade, mas orçamento e perfil alteram", () => {
  const fetchImpl = (async () => { throw Error("não deve enviar"); }) as typeof fetch;
  const a = createVisualClient({ env: lunar, fetchImpl });
  const b = createVisualClient({ env: { ...lunar, OPENAI_API_KEY: "another-fake" }, fetchImpl });
  expect(a.profileKey).toBe(b.profileKey);
  expect(a.profileKey).not.toBe(payloadProfileKey());
  expect(a.profileKey).not.toBe(payloadProfileKey({ profile: "openai-reasoning-none", maxTokens: 10 }));
});
