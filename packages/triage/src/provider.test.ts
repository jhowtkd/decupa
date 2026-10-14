import { describe, expect, it } from "vitest";
import { ASSEMBLY_TEXT_FALLBACK_NOTICE, PRESETS, presetConfig, resolveAssemblyTextProvider, resolveProvider } from "./provider.ts";

describe("resolveProvider", () => {
  it("aceita a escolha explícita", () => {
    expect(resolveProvider("zai", {})).toBe("zai");
    expect(resolveProvider("gemini", {})).toBe("gemini");
    expect(resolveProvider("minimax", {})).toBe("minimax");
    expect(resolveProvider("custom", {})).toBe("custom");
  });

  it("recusa provedor desconhecido", () => {
    expect(() => resolveProvider("openai", {})).toThrow(/custom/);
  });

  it("credentials do projeto vencem o env", () => {
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z" }, { preset: "gemini" })).toBe("gemini");
  });

  it("sem flag, a chave presente decide", () => {
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z" })).toBe("zai");
    expect(resolveProvider(undefined, { GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(resolveProvider(undefined, { MINIMAX_API_KEY: "m" })).toBe("minimax");
  });

  it("sem chave nenhuma, nomeia as variáveis e o caminho manual", () => {
    expect(() => resolveProvider(undefined, {})).toThrow(/ZAI_API_KEY/);
    expect(() => resolveProvider(undefined, {})).toThrow(/na mão/);
  });

  it("TYPESAFE_API_KEY não troca os presets atuais", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(["custom", "gemini", "minimax", "zai"]);
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z", TYPESAFE_API_KEY: "t" })).toBe("zai");
    expect(() => resolveProvider("typesafe", {})).toThrow(/zai|custom/);
  });
});

describe("PRESETS", () => {
  it("zai aponta para o Coding Plan e o GLM flash", () => {
    expect(PRESETS.zai.baseUrl).toContain("api.z.ai");
    expect(PRESETS.zai.model).toBe("glm-5.3-flash");
  });

  it("gemini usa o endpoint OpenAI-compatible do Google", () => {
    expect(PRESETS.gemini.baseUrl).toContain("generativelanguage.googleapis.com");
    expect(PRESETS.gemini.envKey).toBe("GEMINI_API_KEY");
  });

  it("minimax usa chat/completions", () => {
    expect(PRESETS.minimax.baseUrl).toContain("minimax");
    expect(PRESETS.minimax.baseUrl).toContain("chat/completions");
  });
});

describe("presetConfig", () => {
  it("não aplica URL salva de outro preset", () => {
    const cfg = presetConfig("gemini", {}, {
      preset: "zai",
      baseUrl: "https://api.z.ai/hacked",
      model: "glm-hack",
    });
    expect(cfg.baseUrl).toBe(PRESETS.gemini.baseUrl);
    expect(cfg.model).toBe(PRESETS.gemini.model);
    expect(cfg.envKey).toBe("GEMINI_API_KEY");
  });

  it("custom exige URL e modelo", () => {
    expect(() => presetConfig("custom", {})).toThrow(/DECUPA_BASE_URL/);
    const cfg = presetConfig("custom", {
      DECUPA_BASE_URL: "https://x.test/v1/chat/completions",
      DECUPA_MODEL: "foo",
    });
    expect(cfg.baseUrl).toBe("https://x.test/v1/chat/completions");
    expect(cfg.model).toBe("foo");
  });
});

describe("resolveAssemblyTextProvider", () => {
  it.each([
    [{ DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "fake" }, null, "openai", "environment", false, true],
    [{ DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai" }, null, "openai", "environment", false, false],
    [{ DECUPA_ASSEMBLY_TEXT_PROVIDER: "text" }, null, "text", "environment", false, false],
    [{ DECUPA_ASSEMBLY_TEXT_PROVIDER: "text" }, { openaiApiKey: "fake" }, "text", "environment", false, true],
    [{}, { assemblyTextProvider: "openai", openaiApiKey: "fake" }, "openai", "credentials", false, true],
    [{}, { assemblyTextProvider: "openai", openaiApiKey: "fake", assemblyTextProviderSource: "user" as const }, "openai", "user", false, true],
    [{}, { assemblyTextProvider: "openai", openaiApiKey: "fake", assemblyTextProviderSource: "project" as const }, "text", "default", false, true],
    [{}, { assemblyTextProvider: "openai" }, "text", "fallback", true, false],
    [{ OPENAI_API_KEY: " " }, { assemblyTextProvider: "openai" }, "text", "fallback", true, false],
    [{}, null, "text", "default", false, false],
    [{ DECUPA_ASSEMBLY_TEXT_PROVIDER: "" }, { assemblyTextProvider: "openai", openaiApiKey: "fake" }, "openai", "credentials", false, true],
  ] as const)("resolve a tabela de escolha %j / %j", (env, stored, provider, source, notice, configured) => {
    expect(resolveAssemblyTextProvider(env, stored)).toEqual({
      provider, source, configured, notice: notice ? ASSEMBLY_TEXT_FALLBACK_NOTICE : null,
    });
  });

  it("valor desconhecido falha na subida, antes de qualquer resolução de chave", () => {
    expect(() => resolveAssemblyTextProvider({ DECUPA_ASSEMBLY_TEXT_PROVIDER: "typo" })).toThrow(/DECUPA_ASSEMBLY_TEXT_PROVIDER/);
    expect(() => resolveAssemblyTextProvider({ DECUPA_ASSEMBLY_TEXT_PROVIDER: "typo" })).toThrow(/"openai"|"text"/);
  });

  it("ambiente vence a escolha salva, mesmo pedindo texto sobre uma escolha openai gravada", () => {
    const stored = { assemblyTextProvider: "openai" as const, openaiApiKey: "fake" };
    expect(resolveAssemblyTextProvider({ DECUPA_ASSEMBLY_TEXT_PROVIDER: "text" }, stored)).toMatchObject({ provider: "text", source: "environment" });
  });

  it("ter a chave do Luna não autoriza o texto na OpenAI sem a escolha explícita", () => {
    expect(resolveAssemblyTextProvider({ OPENAI_API_KEY: "luna-fake" }, null)).toEqual({ provider: "text", source: "default", configured: true, notice: null });
  });

  it("DECUPA_ASSEMBLY_TEXT_PROVIDER=openai sem chave não cai para o aviso de fallback: a chamada falha explícita adiante", () => {
    expect(resolveAssemblyTextProvider({ DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai" }, null)).toEqual({ provider: "openai", source: "environment", configured: false, notice: null });
  });
});
