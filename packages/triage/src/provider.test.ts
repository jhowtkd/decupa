import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.ts";

describe("resolveProvider", () => {
  it("respeita a escolha explícita mesmo com a outra chave no ambiente", () => {
    expect(resolveProvider("gemini", { ZAI_API_KEY: "z" })).toBe("gemini");
  });

  it("sem flag, quem manda é a chave que existe", () => {
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z" })).toBe("zai");
    expect(resolveProvider(undefined, { GEMINI_API_KEY: "g" })).toBe("gemini");
  });

  it("com as duas chaves, prefere a Z.ai", () => {
    // É a que o projeto usa: o proxy de triagem e os números do SKILL foram
    // medidos nela. Empate resolvido pelo uso real, não por ordem alfabética.
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z", GEMINI_API_KEY: "g" })).toBe("zai");
  });

  it("sem chave nenhuma, nomeia as duas variáveis e o caminho manual", () => {
    expect(() => resolveProvider(undefined, {})).toThrow(/ZAI_API_KEY.*GEMINI_API_KEY/s);
    expect(() => resolveProvider(undefined, {})).toThrow(/na mão/);
  });

  it("recusa provedor que não existe", () => {
    expect(() => resolveProvider("openai", {})).toThrow(/"gemini" ou "zai"/);
  });
});
