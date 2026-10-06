import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/fixtures/global-setup.ts"],
    setupFiles: ["./tests/no-external-network.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Nenhum teste alcança chave real: a mesma lista que o CI zera, mais o que
    // a configuração de empresa e o provedor custom leem do ambiente. A máquina
    // de quem desenvolve exporta chaves; sem isto a suíte local pode pagar.
    env: {
      ZAI_API_KEY: "",
      OPENAI_API_KEY: "",
      DECUPA_VISUAL_PROVIDER: "",
      GEMINI_API_KEY: "",
      MINIMAX_API_KEY: "",
      DECUPA_API_KEY: "",
      TYPESAFE_API_KEY: "",
      DECUPA_COMPANY_API_KEY: "",
      DECUPA_COMPANY_OPENAI_API_KEY: "",
      DECUPA_COMPANY_TYPESAFE_API_KEY: "",
      DECUPA_TYPESAFE: "",
      DECUPA_COMPANY_PRESET: "",
      DECUPA_BASE_URL: "",
      DECUPA_MODEL: "",
    },
  },
});
