import { createHash } from "node:crypto";
import { OPENAI_ASSEMBLY_TEXT_EFFORT } from "./provider.ts";

export type PayloadProfile = "default" | "openai-reasoning-none" | "openai-reasoning-medium";
export const DEFAULT_MAX_TOKENS = 16_000;

/** Perfil sem segredos: orçamento e política também mudam a interpretação do cache. */
export function payloadProfile(opts: { profile?: PayloadProfile; maxTokens?: number; jsonObject?: boolean; inputMode?: "frames" | "text"; model?: string }) {
  const visual = opts.profile === "openai-reasoning-none", medium = opts.profile === "openai-reasoning-medium";
  const openai = visual || medium;
  return {
    profile: opts.profile ?? "default", protocol: "chat-completions", inputMode: opts.inputMode ?? (medium ? "text" : "frames"),
    effort: medium ? OPENAI_ASSEMBLY_TEXT_EFFORT : visual ? "none" : opts.inputMode === "text" && opts.model?.toLowerCase() === "glm-5.3-flash" ? "low" : "model-default",
    detail: visual ? "auto" : "provider-default",
    format: openai || opts.jsonObject !== false ? "json_object" : "text",
    budgetField: openai ? "max_completion_tokens" : "max_tokens",
    maxTokens: Math.max(1, opts.maxTokens ?? DEFAULT_MAX_TOKENS),
    budgetGrowth: visual ? "fixed" : "double-to-64000",
    store: openai ? false : "provider-default",
  };
}

export function payloadProfileKey(opts: Parameters<typeof payloadProfile>[0] = {}): string {
  return createHash("sha256").update(JSON.stringify(payloadProfile(opts))).digest("hex");
}
