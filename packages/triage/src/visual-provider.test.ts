import { expect, it } from "vitest";
import { analysisClientOptions, createVisualClient, visualClientOptions } from "./analysis-client.ts";
import { OPENAI_VISUAL_BASE, resolveVisualProvider } from "./provider.ts";
import { payloadProfileKey } from "./payload-profile.ts";

const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
const lunar = { DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "openai-fake" };
it("somente a ativação explícita muda a visão", () => {
  expect(resolveVisualProvider({})).toBeNull();
  expect(resolveVisualProvider({ OPENAI_API_KEY: "fake" })).toBeNull();
  expect(visualClientOptions({ stored: muse, env: { OPENAI_API_KEY: "fake" } }).model).toBe(muse.model);
  expect(resolveVisualProvider(lunar)).toEqual({ baseUrl: OPENAI_VISUAL_BASE, model: "gpt-6-luna", envKey: "OPENAI_API_KEY", profile: "openai-reasoning-none" });
  expect(() => resolveVisualProvider({ DECUPA_VISUAL_PROVIDER: "typo" })).toThrow(/DECUPA_VISUAL_PROVIDER/);
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
