import { expect, it } from "vitest";
import type { Credentials } from "@decupa/triage";
import { SettingsInputError, textProviderFields, textProviderState } from "./settings-text.ts";

const zai: Credentials = { preset: "zai", apiKey: "old-zai-key" };
const custom: Credentials = { preset: "custom", apiKey: "old-custom-key", model: "muse", baseUrl: "https://meta.example/v1/chat/completions" };

it("textProviderFields: troca só a chave do mesmo provedor, preset omitido, mantém endpoint e modelo", () => {
  const next = textProviderFields({ apiKey: "new-zai-key" }, zai);
  expect(next).toEqual({ preset: "zai", apiKey: "new-zai-key" });
});

it("textProviderFields: troca só a chave do preset personalizado preserva endpoint e modelo sem reenviá-los", () => {
  const next = textProviderFields({ apiKey: "new-custom-key" }, custom);
  expect(next).toEqual({ ...custom, apiKey: "new-custom-key" });
});

it("textProviderFields: trocar o preset sem chave nova recusa antes de checar campos obrigatórios do personalizado", () => {
  expect(() => textProviderFields({ preset: "custom" }, zai)).toThrow(/Informe a chave do novo provedor/);
  // Confere que a mensagem não é a de endpoint/modelo ausente do personalizado.
  try { textProviderFields({ preset: "custom" }, zai); } catch (error) {
    expect((error as Error).message).toBe("Informe a chave do novo provedor");
  }
});

it("textProviderFields: trocar para personalizado com chave nova mas sem endpoint/modelo recusa pela validação do personalizado", () => {
  expect(() => textProviderFields({ preset: "custom", apiKey: "new-custom-key" }, zai))
    .toThrow(/Confira provedor, chave, modelo e endpoint HTTPS\./);
});

it("textProviderFields: trocar o endpoint do mesmo preset sem chave nova recusa, mesmo com modelo igual", () => {
  expect(() => textProviderFields({ baseUrl: "https://outro.example/v1/chat/completions" }, custom))
    .toThrow(/Informe a chave do novo provedor/);
});

it("textProviderFields: trocar o endpoint com chave nova usa só a chave nova, nunca a antiga", () => {
  const next = textProviderFields({ apiKey: "fresh-key", baseUrl: "https://outro.example/v1/chat/completions" }, custom);
  expect(next).toMatchObject({ apiKey: "fresh-key", baseUrl: "https://outro.example/v1/chat/completions" });
  expect(next.apiKey).not.toBe(custom.apiKey);
});

it("textProviderFields: endpoint inválido (sem HTTPS, com credenciais/consulta/fragmento) recusa", () => {
  for (const baseUrl of ["http://outro.example/v1", "https://user:pass@outro.example/v1", "https://outro.example/v1?x=1", "https://outro.example/v1#frag"]) {
    expect(() => textProviderFields({ preset: "custom", apiKey: "fresh-key", model: "muse", baseUrl }, zai)).toThrow(SettingsInputError);
  }
});

it("textProviderFields: campo não reconhecido no corpo recusa", () => {
  expect(() => textProviderFields({ apiKey: "x", extra: 1 } as never, zai)).toThrow(SettingsInputError);
});

it("textProviderFields: chave acima do limite ou com espaço/controle interno recusa", () => {
  for (const apiKey of ["x".repeat(401), "a b", "a\nb", "a\u0000b"]) {
    expect(() => textProviderFields({ apiKey }, zai)).toThrow(/Confira a chave de API\./);
  }
});

it("textProviderState: fonte projeto avisa que o que for salvo vale para outros projetos", () => {
  const state = textProviderState({}, { ...zai, textProviderSource: "project" } as Credentials);
  expect(state).toMatchObject({ configured: true, source: "project" });
  expect(state.notice).toMatch(/configuração própria|vale para os outros projetos/);
});

it("textProviderState: fonte ambiente avisa que a chave do ambiente está em uso por falta de configuração salva", () => {
  const state = textProviderState({ ZAI_API_KEY: "env-key" }, null);
  expect(state).toMatchObject({ configured: true, source: "environment" });
  expect(state.notice).toMatch(/ambiente está em uso/);
});

it("textProviderState: fonte usuário (credenciais locais) não mostra aviso", () => {
  const state = textProviderState({}, { ...zai, textProviderSource: "user" } as Credentials);
  expect(state).toMatchObject({ configured: true, source: "user", notice: null });
});

it("textProviderState: sem texto configurado nem ambiente pede configuração, sem quebrar", () => {
  const state = textProviderState({}, null);
  expect(state).toMatchObject({ configured: false, preset: "zai", model: null, baseUrl: null });
  expect(state.notice).toMatch(/Configure o provedor de texto/);
});
