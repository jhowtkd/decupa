import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.ts";
import { companyCredentialsFromEnv, envWithStoredTypeSafe, installCompanyCredentials, resolveTypeSafe } from "./company-credentials.ts";
import { readAnalysisCredentials } from "./analysis-credentials.ts";
import { createAssemblyDecisionContext } from "../../../apps/cli/src/app/assembly/assembly-decisions.ts";

describe("companyCredentialsFromEnv", () => {
  it("inclui somente Luna da empresa sem persistir OpenAI solta do ambiente", () => {
    expect(companyCredentialsFromEnv({ DECUPA_COMPANY_API_KEY: "muse", DECUPA_COMPANY_OPENAI_API_KEY: "company-luna", OPENAI_API_KEY: "env-luna", TYPESAFE_API_KEY: "jev" })).toMatchObject({ apiKey: "muse", openaiApiKey: "company-luna", typesafeApiKey: "jev" });
    expect(companyCredentialsFromEnv({ ZAI_API_KEY: "text", OPENAI_API_KEY: "luna" })?.openaiApiKey).toBeUndefined();
  });
  it("lê DECUPA_COMPANY_API_KEY com preset zai por padrão", () => {
    expect(companyCredentialsFromEnv({ DECUPA_COMPANY_API_KEY: "  empresa-secret  " })).toEqual({
      preset: "zai",
      apiKey: "empresa-secret",
    });
  });

  it("chave definida com preset vazio usa zai", () => {
    expect(companyCredentialsFromEnv({
      DECUPA_COMPANY_API_KEY: "empresa-secret",
      DECUPA_COMPANY_PRESET: "",
    })).toEqual({ preset: "zai", apiKey: "empresa-secret" });
    expect(companyCredentialsFromEnv({
      DECUPA_COMPANY_API_KEY: "empresa-secret",
      DECUPA_COMPANY_PRESET: "   ",
    })).toEqual({ preset: "zai", apiKey: "empresa-secret" });
  });

  it("respeita DECUPA_COMPANY_PRESET", () => {
    expect(companyCredentialsFromEnv({
      DECUPA_COMPANY_API_KEY: "g",
      DECUPA_COMPANY_PRESET: "gemini",
    })).toEqual({ preset: "gemini", apiKey: "g" });
  });

  it("cai nas chaves já reconhecidas quando a da empresa não está setada", () => {
    expect(companyCredentialsFromEnv({ ZAI_API_KEY: "z" })).toEqual({ preset: "zai", apiKey: "z" });
    expect(companyCredentialsFromEnv({ GEMINI_API_KEY: "g" })).toEqual({ preset: "gemini", apiKey: "g" });
  });

  it("devolve null sem chave e com string vazia", () => {
    expect(companyCredentialsFromEnv({})).toBeNull();
    expect(companyCredentialsFromEnv({ DECUPA_COMPANY_API_KEY: "  ", ZAI_API_KEY: "" })).toBeNull();
  });

  it("recusa preset inválido sem incluir a chave no erro", () => {
    expect(() => companyCredentialsFromEnv({
      DECUPA_COMPANY_API_KEY: "segredo-nao-vazar",
      DECUPA_COMPANY_PRESET: "openai",
    })).toThrow(/DECUPA_COMPANY_PRESET/);
    try {
      companyCredentialsFromEnv({
        DECUPA_COMPANY_API_KEY: "segredo-nao-vazar",
        DECUPA_COMPANY_PRESET: "openai",
      });
    } catch (error) {
      expect(String(error)).not.toContain("segredo-nao-vazar");
    }
  });
});

describe("installCompanyCredentials", () => {
  it("preenche uma chave do Jev sem reativar uma escolha explícita de desligar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "company-disabled-"));
    await writeCredentials(dir, { preset: "zai", apiKey: "text", typesafe: false });
    await installCompanyCredentials(dir, { TYPESAFE_API_KEY: "company-jev" });
    expect(await readCredentials(dir)).toMatchObject({ apiKey: "text", typesafeApiKey: "company-jev", typesafe: false });
  });
  it("Luna da empresa entra só na primeira configuração; ambiente puro não altera arquivo existente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "company-keys-"));
    await writeCredentials(dir, { preset: "custom", apiKey: "muse", model: "m", baseUrl: "https://meta.example/v1", typesafeApiKey: "old-jev", typesafe: false });
    const before = await readFile(credentialsPath(dir), "utf8");
    for (const env of [{ OPENAI_API_KEY: "luna" }, { DECUPA_COMPANY_API_KEY: "new-muse", DECUPA_COMPANY_OPENAI_API_KEY: "company-luna", TYPESAFE_API_KEY: "new-jev" }]) {
      expect(await installCompanyCredentials(dir, env)).toEqual({ status: "skipped" });
      expect(await readFile(credentialsPath(dir), "utf8")).toBe(before);
    }
    const first = await mkdtemp(join(tmpdir(), "company-luna-first-"));
    await installCompanyCredentials(first, { DECUPA_COMPANY_API_KEY: "text", DECUPA_COMPANY_OPENAI_API_KEY: "company-luna" });
    expect((await readCredentials(first))?.openaiApiKey).toBe("company-luna");
    const absent = await mkdtemp(join(tmpdir(), "company-openai-only-"));
    expect(await installCompanyCredentials(absent, { OPENAI_API_KEY: "luna" })).toEqual({ status: "absent" });
    await expect(readFile(credentialsPath(absent))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("grava no diretório do usuário e restringe permissão", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-company-"));
    const result = await installCompanyCredentials(dir, { DECUPA_COMPANY_API_KEY: "empresa-secret" });
    expect(result).toEqual({ status: "installed" });
    expect(await readCredentials(dir)).toEqual({ preset: "zai", apiKey: "empresa-secret" });
    if (process.platform !== "win32") {
      expect((await stat(credentialsPath(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it("não sobrescreve credencial já válida", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-company-keep-"));
    await writeCredentials(dir, { preset: "gemini", apiKey: "ja-tinha" });
    const result = await installCompanyCredentials(dir, { DECUPA_COMPANY_API_KEY: "nova" });
    expect(result).toEqual({ status: "skipped" });
    expect((await readCredentials(dir))?.apiKey).toBe("ja-tinha");
  });

  it("não cria arquivo quando o ambiente não tem chave", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-company-absent-"));
    expect(await installCompanyCredentials(dir, {})).toEqual({ status: "absent" });
    await expect(readFile(credentialsPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("grava a chave do Jev junto com a da análise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-company-jev-"));
    const result = await installCompanyCredentials(dir, {
      DECUPA_COMPANY_API_KEY: "empresa-secret",
      TYPESAFE_API_KEY: "jev-secret",
      DECUPA_TYPESAFE: "1",
    });
    expect(result).toEqual({ status: "installed" });
    expect(await readCredentials(dir)).toEqual({
      preset: "zai",
      apiKey: "empresa-secret",
      typesafeApiKey: "jev-secret",
      typesafe: true,
    });
  });

  it("acrescenta o Jev numa credencial de análise já gravada, sem trocar a chave", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-company-jev-merge-"));
    await writeCredentials(dir, { preset: "gemini", apiKey: "ja-tinha" });
    const result = await installCompanyCredentials(dir, {
      DECUPA_COMPANY_API_KEY: "nova-analise",
      TYPESAFE_API_KEY: "jev-secret",
      DECUPA_TYPESAFE: "1",
    });
    expect(result).toEqual({ status: "installed" });
    expect(await readCredentials(dir)).toEqual({
      preset: "gemini",
      apiKey: "ja-tinha",
      typesafeApiKey: "jev-secret",
      typesafe: true,
    });
  });
});

describe("envWithStoredTypeSafe", () => {
  it.each(["true", "false", "2", " 1 "])("flag %j desliga no estado e no cliente, mesmo com consentimento salvo", flag => {
    const env = { TYPESAFE_API_KEY: "env-key", DECUPA_TYPESAFE: flag };
    const stored = { preset: "zai" as const, typesafe: true, typesafeApiKey: "stored-key" };
    expect(resolveTypeSafe(env, stored)).toMatchObject({ enabled: false, source: "environment", notice: "Decisões automáticas desligadas: ative o Jev →" });
    const context = createAssemblyDecisionContext(null, envWithStoredTypeSafe(env, stored));
    expect(context.mode).toBe("off"); expect(context.client).toBeUndefined();
  });
  it.each([
    [{ TYPESAFE_API_KEY: "env-key" }, null],
    [{}, { preset: "zai" as const, typesafeApiKey: "legacy-key" }],
  ])("uma chave sem consentimento fica sem cliente e avisa para ativar %j", (env, stored) => {
    expect(resolveTypeSafe(env, stored)).toMatchObject({ configured: true, enabled: false, notice: "Decisões automáticas desligadas: ative o Jev →" });
    const context = createAssemblyDecisionContext(null, envWithStoredTypeSafe(env, stored));
    expect(context.mode).toBe("off"); expect(context.client).toBeUndefined();
  });
  it("preserva desligamento explícito e ambiente vence chave e flag salvas", () => {
    const stored = { preset: "zai" as const, typesafeApiKey: "saved", typesafe: false };
    expect(envWithStoredTypeSafe({}, stored)).toMatchObject({ TYPESAFE_API_KEY: "saved", DECUPA_TYPESAFE: "0" });
    expect(envWithStoredTypeSafe({ TYPESAFE_API_KEY: "env", DECUPA_TYPESAFE: "1" }, stored)).toMatchObject({ TYPESAFE_API_KEY: "env", DECUPA_TYPESAFE: "1" });
    expect(resolveTypeSafe({}, stored)).toMatchObject({ enabled: false, notice: null });
    expect(resolveTypeSafe({ DECUPA_TYPESAFE: "0" }, null).notice).toBeNull();
    expect(resolveTypeSafe({}, null).notice).toContain("sem chave");
  });
  it("preenche TYPESAFE_API_KEY e DECUPA_TYPESAFE a partir do arquivo", () => {
    const env = envWithStoredTypeSafe({}, {
      preset: "zai",
      typesafeApiKey: "jev-secret",
      typesafe: true,
    });
    expect(env.TYPESAFE_API_KEY).toBe("jev-secret");
    expect(env.DECUPA_TYPESAFE).toBe("1");
    expect(envWithStoredTypeSafe({ TYPESAFE_API_KEY: "ja-no-env" }, {
      preset: "zai",
      typesafeApiKey: "jev-secret",
    }).TYPESAFE_API_KEY).toBe("ja-no-env");
  });
});

it("usuário vence campos de Luna/Jev do projeto; texto conserva a credencial do projeto", async () => {
  const user = await mkdtemp(join(tmpdir(), "keys-user-")), project = await mkdtemp(join(tmpdir(), "keys-project-"));
  await writeCredentials(project, { preset: "gemini", apiKey: "project-text", openaiApiKey: "project-luna", visualProvider: "text", typesafeApiKey: "project-jev", typesafe: true });
  await writeCredentials(user, { preset: "zai", apiKey: "user-text", openaiApiKey: "user-luna", visualProvider: "openai", typesafeApiKey: "user-jev", typesafe: false });
  expect(await readAnalysisCredentials(project, user)).toMatchObject({ preset: "gemini", apiKey: "project-text", openaiApiKey: "user-luna", visualProvider: "openai", typesafeApiKey: "user-jev", typesafe: false, openaiApiKeySource: "user", visualProviderSource: "user", typesafeSource: "user" });
});
