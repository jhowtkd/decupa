import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectArtifact, publishAtomic } from "@decupa/cache";

export interface CacheKeyParts {
  videoSha: string;
  indexSha: string;
  promptVersion: string;
  model: string;
  pass: "structure" | "density" | "inspect";
  budgetSeconds?: number;
  unitId?: string;
  framesSha?: string;
  providerId?: string;
}

/**
 * Mandar o vídeo pro modelo custa e demora, e a resposta não é determinística.
 * O cache é o que devolve reprodutibilidade: a mesma entrada dá a mesma
 * decisão, e daqui a seis meses dá para ler o que o modelo disse e por quê.
 *
 * O passe entra na chave para que mudar `--target` re-rode só a densidade.
 * O orçamento de tempo também entra quando o passe é de densidade.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const elements = [parts.videoSha, parts.indexSha, parts.promptVersion, parts.model, parts.pass];
  if (parts.providerId) elements.push(parts.providerId);
  if (parts.pass === "density" && parts.budgetSeconds !== undefined) {
    elements.push(parts.budgetSeconds.toFixed(1));
  }
  if (parts.pass === "inspect") {
    elements.push(parts.unitId ?? "");
    elements.push(parts.framesSha ?? "");
  }
  return createHash("sha256")
    .update(elements.join(" "))
    .digest("hex");
}

export async function readCache<T>(dir: string, key: string): Promise<T | null> {
  const inspection = await inspectArtifact(join(dir, `${key}.json`));
  if (inspection.status !== "ready") return null;
  return inspection.value as T;
}

export async function writeCache(dir: string, key: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await publishAtomic(join(dir, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export function providerIdentity(cfg: { provider: string; model: string; baseUrl: string }): string {
  return `${cfg.provider}|${cfg.model}|${cfg.baseUrl}`;
}
