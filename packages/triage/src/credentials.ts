import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Provider, StoredProvider } from "./provider.ts";

export type Credentials = StoredProvider & { apiKey?: string };

const FILE = "credentials";

export function credentialsPath(dir: string): string {
  if (!isAbsolute(dir)) {
    throw new Error("diretório do projeto precisa ser absoluto");
  }
  return join(resolve(dir), ".decupa", FILE);
}

export async function readCredentials(dir: string): Promise<Credentials | null> {
  const path = credentialsPath(dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("credentials do Decupa ilegíveis");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("credentials do Decupa ilegíveis");
  }
  const rec = parsed as Record<string, unknown>;
  const preset = rec.preset;
  if (preset !== "zai" && preset !== "gemini" && preset !== "minimax" && preset !== "custom") {
    throw new Error("credentials do Decupa com preset inválido");
  }
  const out: Credentials = { preset: preset as Provider };
  if (typeof rec.model === "string" && rec.model.length > 0) out.model = rec.model;
  if (typeof rec.baseUrl === "string" && rec.baseUrl.length > 0) out.baseUrl = rec.baseUrl;
  if (typeof rec.apiKey === "string" && rec.apiKey.length > 0) out.apiKey = rec.apiKey;
  return out;
}

export async function writeCredentials(dir: string, creds: Credentials): Promise<string> {
  const path = credentialsPath(dir);
  await mkdir(join(resolve(dir), ".decupa"), { recursive: true });
  const body: Credentials = { preset: creds.preset };
  if (creds.model) body.model = creds.model;
  if (creds.baseUrl) body.baseUrl = creds.baseUrl;
  if (creds.apiKey) body.apiKey = creds.apiKey;
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await chmod(path, 0o600);
  return path;
}
