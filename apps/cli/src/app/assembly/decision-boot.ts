import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bootDecision, parseDecisionConfig, type DecisionBoot } from "@decupa/typesafe/config";

export async function bootProjectDecision(opts: {
  projectDir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<DecisionBoot> {
  const env = opts.env ?? process.env;
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(join(opts.projectDir, ".decupa", "decision.json"), "utf8"));
  } catch {
    raw = null;
  }
  const config = parseDecisionConfig(raw, env);
  return bootDecision({
    config,
    fetchImpl: opts.fetchImpl,
    apiKey: env.TYPESAFE_API_KEY,
  });
}
