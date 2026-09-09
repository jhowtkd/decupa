import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.ts";

describe("resolveProvider", () => {
  it("aceita a escolha explícita", () => {
    expect(resolveProvider("zai", {})).toBe("zai");
  });

  it("recusa gemini nomeando o que aconteceu", () => {
    // Quem voltar de um shell antigo com --provider gemini merece um erro
    // que explica a decisão, não "valor inválido".
    expect(() => resolveProvider("gemini", { ZAI_API_KEY: "z" })).toThrow(/Gemini foi retirado/);
  });

  it("sem flag, a chave presente decide", () => {
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z" })).toBe("zai");
  });

  it("sem chave nenhuma, nomeia a variável e o caminho manual", () => {
    expect(() => resolveProvider(undefined, {})).toThrow(/ZAI_API_KEY/);
    expect(() => resolveProvider(undefined, {})).toThrow(/na mão/);
  });
});
