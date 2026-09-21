import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.ts";
import { companyCredentialsFromEnv, envWithStoredTypeSafe, installCompanyCredentials } from "./company-credentials.ts";

describe("companyCredentialsFromEnv", () => {
  it("lê DECUPA_COMPANY_API_KEY com preset zai por padrão", () => {
    expect(companyCredentialsFromEnv({ DECUPA_COMPANY_API_KEY: "  empresa-secret  " })).toEqual({
      preset: "zai",
      apiKey: "empresa-secret",
    });
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
