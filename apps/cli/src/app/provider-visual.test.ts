import { expect, it } from "vitest";
import { assemblyTextProviderState, keyProviderState, validateVisualProvider } from "./provider-visual.ts";

const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };

it("validateVisualProvider aceita assemblyTextProvider isolado, sem exigir a escolha da visão", () => {
  expect(validateVisualProvider({ assemblyTextProvider: "openai" })).toEqual({ assemblyTextProvider: "openai" });
  expect(validateVisualProvider({ assemblyTextProvider: "text" })).toEqual({ assemblyTextProvider: "text" });
});

it("validateVisualProvider recusa valor fora de openai/text para o texto da Montagem", () => {
  expect(() => validateVisualProvider({ assemblyTextProvider: "sol-direto" })).toThrow(/texto da Montagem/);
});

it("validateVisualProvider recusa objeto sem nenhum campo reconhecido", () => {
  expect(() => validateVisualProvider({})).toThrow();
});

it("validateVisualProvider combina visão e texto da Montagem no mesmo POST", () => {
  const key = "fake-openai-key-1234567890";
  expect(validateVisualProvider({ visualProvider: "openai", openaiApiKey: key, assemblyTextProvider: "openai" }))
    .toEqual({ visualProvider: "openai", openaiApiKey: key, assemblyTextProvider: "openai" });
});

it("assemblyTextProviderState: openai expõe modelo/esforço fixos sem rede", () => {
  const state = assemblyTextProviderState({ DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "fake" }, null);
  expect(state).toMatchObject({ provider: "openai", model: "gpt-6.1-sol", effort: "medium", configured: true });
});

it("assemblyTextProviderState: texto expõe o modelo/esforço efetivo do provedor de texto configurado", () => {
  const state = assemblyTextProviderState({}, muse);
  expect(state).toMatchObject({ provider: "text", model: muse.model });
});

it("assemblyTextProviderState: primeira abertura sem texto configurado não quebra (modelo nulo)", () => {
  const state = assemblyTextProviderState({}, null);
  expect(state).toMatchObject({ provider: "text", model: null, effort: null });
});

it("keyProviderState: aviso do texto da Montagem se junta ao combinado de visão+Jev", () => {
  const state = keyProviderState({}, { ...muse, visualProvider: "openai", assemblyTextProvider: "openai" });
  expect(state.notice).toContain("Chaves de IA pendentes");
  expect(state.notice).toContain("texto da Montagem");
});

it("keyProviderState: sem aviso de visão/Jev, o aviso isolado do texto da Montagem aparece sozinho", () => {
  const state = keyProviderState({}, { ...muse, visualProvider: "text", typesafe: false, assemblyTextProvider: "openai" });
  expect(state.notice).toBe(state.assemblyText.notice);
});

it("keyProviderState: nenhuma escolha de texto da Montagem não produz aviso", () => {
  const state = keyProviderState({}, muse);
  expect(state.assemblyText).toMatchObject({ provider: "text", notice: null });
});
