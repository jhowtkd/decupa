import { expect, it } from "vitest";
import { readAnalysisCredentials } from "./analysis-credentials.ts";
import type { Credentials } from "./credentials.ts";
import { resolveAssemblyTextProvider } from "./provider.ts";

const project: Credentials = { preset: "zai", apiKey: "project-text" };

it("assemblyTextProvider do usuário vence o do projeto, com a origem marcada 'user'", async () => {
  const user: Credentials = { preset: "zai", apiKey: "user-text", assemblyTextProvider: "openai" };
  const read = async (dir: string) => (dir === "/user" ? user : { ...project, assemblyTextProvider: "text" as const });
  const result = await readAnalysisCredentials("/project", "/user", read);
  expect(result).toMatchObject({ assemblyTextProvider: "openai", assemblyTextProviderSource: "user" });
});

it("sem escolha do usuário, usa text do projeto com origem 'project'", async () => {
  const user: Credentials = { preset: "zai", apiKey: "user-text" };
  const read = async (dir: string) => (dir === "/user" ? user : { ...project, assemblyTextProvider: "text" as const });
  const result = await readAnalysisCredentials("/project", "/user", read);
  expect(result).toMatchObject({ assemblyTextProvider: "text", assemblyTextProviderSource: "project" });
});

it("projeto recebido com openai não ativa o Sol nem aviso com a chave do usuário", async () => {
  const user: Credentials = { preset: "zai", apiKey: "user-text", openaiApiKey: "user-luna" };
  const read = async (dir: string) => dir === "/user" ? user : { ...project, assemblyTextProvider: "openai" as const };
  const result = await readAnalysisCredentials("/project", "/user", read);
  expect(result).not.toHaveProperty("assemblyTextProvider");
  expect(result).not.toHaveProperty("assemblyTextProviderSource");
  expect(resolveAssemblyTextProvider({}, result)).toEqual({ provider: "text", source: "default", configured: true, notice: null });
  expect(resolveAssemblyTextProvider({ DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai" }, result)).toMatchObject({ provider: "openai", source: "environment" });
});

it("nenhum dos dois configurou: o campo e a origem ficam ausentes", async () => {
  const user: Credentials = { preset: "zai", apiKey: "user-text" };
  const read = async (dir: string) => (dir === "/user" ? user : project);
  const result = await readAnalysisCredentials("/project", "/user", read);
  expect(result).not.toHaveProperty("assemblyTextProvider");
  expect(result).not.toHaveProperty("assemblyTextProviderSource");
});

it("texto da Montagem não herda a chave do Luna: openaiApiKey segue sua própria precedência, intacta", async () => {
  const user: Credentials = { preset: "zai", apiKey: "user-text", openaiApiKey: "user-luna", assemblyTextProvider: "openai" };
  const read = async (dir: string) => (dir === "/user" ? user : { ...project, openaiApiKey: "project-luna" });
  const result = await readAnalysisCredentials("/project", "/user", read);
  expect(result).toMatchObject({ openaiApiKey: "user-luna", openaiApiKeySource: "user", assemblyTextProvider: "openai", assemblyTextProviderSource: "user" });
});
