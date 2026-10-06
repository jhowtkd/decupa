import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { envWithStoredTypeSafe, mtimeCached, type Credentials } from "@decupa/triage";
import { resolveAppTransports } from "./analysis-transports.ts";
import { createAssemblyDecisionContext } from "./assembly/assembly-decisions.ts";
import type { VisualClient } from "./assembly/model.ts";

/** Um snapshot por operação: trocar a tela não muda clientes já em uso. */
export function operationResolver(opts: {
  dir: string; loadStored: () => Promise<Credentials | null>; env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch; describeClient?: VisualClient; enableVisual: boolean;
  proposeSend?: VisualClient["send"]; enableText?: boolean;
}) {
  const readDecision = mtimeCached(async path => {
    try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  return async () => {
    const stored = await opts.loadStored();
    const env = envWithStoredTypeSafe(opts.env, stored);
    const raw = await readDecision(join(opts.dir, ".decupa", "decision.json"));
    const decision = createAssemblyDecisionContext(raw, env, opts.fetchImpl);
    const transports = resolveAppTransports({ stored, env, fetchImpl: opts.fetchImpl, describeClient: opts.describeClient });
    // Só uma impressão privada para distinguir tentativas com chaves diferentes.
    const fillerConfigKey = createHash("sha256").update(JSON.stringify([env.TYPESAFE_API_KEY, env.DECUPA_TYPESAFE, decision.model, decision.mode])).digest("hex");
    return { decision, fillerEnv: env, fillerConfigKey,
      ...(opts.proposeSend || opts.enableText ? { proposeSend: opts.proposeSend ?? transports.textSend } : {}),
      describeClient: opts.enableVisual ? transports.visualClient : undefined };
  };
}
