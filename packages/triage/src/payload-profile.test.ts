import { expect, it } from "vitest";
import { payloadProfile, payloadProfileKey } from "./payload-profile.ts";

// Baseline literal de d1e1c4d (antes do perfil medium/Sol existir), reproduzido
// isolado em packages/triage/src/payload-profile.test.ts:
//   const openai = opts.profile === "openai-reasoning-none";
//   return { profile: opts.profile ?? "default", protocol: "chat-completions", inputMode: opts.inputMode ?? "frames",
//     effort: openai ? "none" : ..., detail: openai ? "auto" : "provider-default",
//     format: openai || opts.jsonObject !== false ? "json_object" : "text",
//     budgetField: openai ? "max_completion_tokens" : "max_tokens", maxTokens: ...,
//     budgetGrowth: openai ? "fixed" : "double-to-64000", store: openai ? false : "provider-default" };
// A ordem das chaves do objeto decide o JSON.stringify e, portanto, o hash
// (nome do diretório de cache): comparar com toEqual não pegaria uma
// reordenação de campo. Por isso a string/hash abaixo é literal, travada no
// baseline, não recalculada pela função atual.
const DEFAULT_PROFILE_JSON = '{"profile":"default","protocol":"chat-completions","inputMode":"frames","effort":"model-default","detail":"provider-default","format":"json_object","budgetField":"max_tokens","maxTokens":16000,"budgetGrowth":"double-to-64000","store":"provider-default"}';
const DEFAULT_PROFILE_HASH = "532a08238655e7c1e369dd5c4d8b151bab82247b54ae2b98e9b68722a6ef4293";
const NONE_PROFILE_JSON = '{"profile":"openai-reasoning-none","protocol":"chat-completions","inputMode":"frames","effort":"none","detail":"auto","format":"json_object","budgetField":"max_completion_tokens","maxTokens":16000,"budgetGrowth":"fixed","store":false}';
const NONE_PROFILE_HASH = "1e95ed34f3d4cb15945527c675465b22dd9937c747d068e386b9c5264e628702";

it("default: objeto e chave de cache idênticos byte a byte ao baseline d1e1c4d", () => {
  expect(JSON.stringify(payloadProfile({}))).toBe(DEFAULT_PROFILE_JSON);
  expect(payloadProfileKey({})).toBe(DEFAULT_PROFILE_HASH);
  expect(payloadProfile({ inputMode: "text", model: "glm-5.3-flash" })).toMatchObject({ effort: "low" });
  expect(payloadProfile({ jsonObject: false })).toMatchObject({ format: "text" });
});

it("openai-reasoning-none: objeto e chave de cache idênticos byte a byte ao baseline d1e1c4d", () => {
  expect(JSON.stringify(payloadProfile({ profile: "openai-reasoning-none" }))).toBe(NONE_PROFILE_JSON);
  expect(payloadProfileKey({ profile: "openai-reasoning-none" })).toBe(NONE_PROFILE_HASH);
});

it("openai-reasoning-medium tem perfil próprio: texto, esforço medium, orçamento que dobra", () => {
  expect(payloadProfile({ profile: "openai-reasoning-medium" })).toEqual({
    profile: "openai-reasoning-medium", protocol: "chat-completions", inputMode: "text",
    effort: "medium", detail: "provider-default", format: "json_object",
    budgetField: "max_completion_tokens", maxTokens: 16_000, budgetGrowth: "double-to-64000", store: false,
  });
  // Mesmo mandando frames, o perfil medium não é de visão: detail não é "auto".
  expect(payloadProfile({ profile: "openai-reasoning-medium", inputMode: "frames" })).toMatchObject({ detail: "provider-default", inputMode: "frames" });
});

it("a chave do perfil medium nunca colide com default/none/outro orçamento, e os dois baselines nunca colidem com medium", () => {
  const medium = payloadProfileKey({ profile: "openai-reasoning-medium" });
  expect(new Set([DEFAULT_PROFILE_HASH, NONE_PROFILE_HASH, medium]).size).toBe(3);
  expect(payloadProfileKey({ profile: "openai-reasoning-medium", maxTokens: 32_000 })).not.toBe(medium);
});
