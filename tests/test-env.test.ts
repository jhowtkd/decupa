import { describe, expect, it } from "vitest";

const CLEARED = [
  "ZAI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MINIMAX_API_KEY",
  "DECUPA_API_KEY",
  "TYPESAFE_API_KEY",
  "DECUPA_COMPANY_API_KEY",
  "DECUPA_COMPANY_PRESET",
  "DECUPA_BASE_URL",
  "DECUPA_MODEL",
] as const;

describe("vitest env", () => {
  it.each(CLEARED)("%s fica vazio dentro do vitest", (key) => {
    expect(process.env[key]).toBe("");
  });
});
