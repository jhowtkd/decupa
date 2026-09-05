import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CacheKeyParts {
  videoSha: string;
  indexSha: string;
  promptVersion: string;
  model: string;
  pass: "structure" | "density" | "inspect";
  budgetSeconds?: number;
  unitId?: string;
  framesSha?: string;
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
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as T;
  } catch {
    // Ausente ou corrompido dão no mesmo: re-perguntar ao modelo é correto e
    // apenas custa. Estourar aqui transformaria um cache ruim em falha dura.
    return null;
  }
}

export async function writeCache(dir: string, key: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
