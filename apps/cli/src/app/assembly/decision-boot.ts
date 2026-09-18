import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootDecision,
  decisionLogLine,
  parseDecisionConfig,
  type DecisionBoot,
} from "@decupa/typesafe/config";

export async function bootProjectDecision(opts: {
  projectDir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<DecisionBoot> {
  const env = opts.env ?? process.env;
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(join(opts.projectDir, ".decupa", "decision.json"), "utf8"));
  } catch {
    raw = null;
  }
  const config = parseDecisionConfig(raw, env);
  const started = Date.now();
  const boot = await bootDecision({
    config,
    fetchImpl: opts.fetchImpl,
    apiKey: env.TYPESAFE_API_KEY,
  });
  const line = decisionLogLine({
    provider: "typesafe",
    model: config.model,
    elapsedMs: Math.max(0, Date.now() - started),
    fallback: boot.fallback ?? false,
    apiKey: env.TYPESAFE_API_KEY,
  });
  (opts.log ?? ((text: string) => console.log(text)))(line);
  return boot;
}
