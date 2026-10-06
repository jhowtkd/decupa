import { dirname } from "node:path";
import { credentialsPath, readCredentials, type Credentials } from "./credentials.ts";
import { mtimeCached } from "./config-cache.ts";
export type AnalysisCredentials = Credentials & {
  openaiApiKeySource?: "user" | "project";
  visualProviderSource?: "user" | "project";
  assemblyTextProviderSource?: "user" | "project";
  typesafeSource?: "user" | "project";
  typesafeApiKeySource?: "user" | "project";
};

/** Texto conserva o projeto; visão e Jev usam a configuração do usuário. */
export async function readAnalysisCredentials(dir: string, userDir: string,
  read: typeof readCredentials = readCredentials): Promise<AnalysisCredentials | null> {
  const project = await read(dir).catch(() => null);
  const user = dir === userDir ? project : await read(userDir).catch(() => null);
  const text = project ?? user;
  if (!text) return null;
  const out: AnalysisCredentials = { ...text };
  // A tela configura visão/Jev deste computador sem mudar o provedor de texto.
  const openaiApiKey = user?.openaiApiKey ?? project?.openaiApiKey;
  const visualProvider = user?.visualProvider ?? project?.visualProvider;
  if (openaiApiKey) { out.openaiApiKey = openaiApiKey; out.openaiApiKeySource = user?.openaiApiKey ? "user" : "project"; }
  if (visualProvider) { out.visualProvider = visualProvider; out.visualProviderSource = user?.visualProvider ? "user" : "project"; }
  // A escolha paga do Sol pertence ao computador, não ao projeto recebido.
  delete out.assemblyTextProvider;
  const assemblyTextProvider = user?.assemblyTextProvider ?? (project?.assemblyTextProvider === "text" ? "text" : undefined);
  if (assemblyTextProvider) { out.assemblyTextProvider = assemblyTextProvider; out.assemblyTextProviderSource = user?.assemblyTextProvider ? "user" : "project"; }
  const typesafeApiKey = user?.typesafeApiKey ?? project?.typesafeApiKey;
  const typesafe = user?.typesafe ?? project?.typesafe;
  if (typesafeApiKey) { out.typesafeApiKey = typesafeApiKey; out.typesafeApiKeySource = user?.typesafeApiKey ? "user" : "project"; }
  if (typesafe !== undefined) { out.typesafe = typesafe; out.typesafeSource = user?.typesafe !== undefined ? "user" : "project"; }
  return out;
}

/** A instância pertence ao servidor; não retém configurações de outras sessões. */
export function createCredentialsReader(load: typeof readCredentials = readCredentials) {
  const cached = mtimeCached(path => load(dirname(dirname(path))).catch(() => null));
  return Object.assign((dir: string) => cached(credentialsPath(dir)), {
    invalidate: (dir: string): void => { cached.invalidate(credentialsPath(dir)); },
  });
}
