import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.ts";
import { isRestrictedAcl, parseIcaclsOutput, parseWhoamiUserSid } from "./windows-acl.ts";

const run = promisify(execFile);
const windowsCommandOptions = { shell: false, windowsHide: true, timeout: 30_000 } as const;

async function windowsAcl(path: string): Promise<string> {
  const { stdout } = await run("icacls.exe", [path], windowsCommandOptions);
  return stdout;
}

async function expectPrivate(path: string): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    return;
  }
  const { stdout } = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], windowsCommandOptions);
  const sid = parseWhoamiUserSid(stdout);
  expect(isRestrictedAcl(parseIcaclsOutput(await windowsAcl(path)), sid)).toBe(true);
}

describe("credentials", () => {
  it("conserva visão e Jev, inclusive o desligamento, ao regravar o texto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-keys-"));
    await writeCredentials(dir, { preset: "custom", apiKey: "muse", model: "muse", baseUrl: "https://meta.example/v1", openaiApiKey: "luna", visualProvider: "text", typesafeApiKey: "jev", typesafe: false });
    const path = await writeCredentials(dir, { preset: "gemini", apiKey: "text" });
    await expectPrivate(path);
    expect(await readCredentials(dir)).toEqual({ preset: "gemini", apiKey: "text", openaiApiKey: "luna", visualProvider: "text", typesafeApiKey: "jev", typesafe: false });
  });

  it("grava e conserva assemblyTextProvider ao regravar outro campo; arquivo antigo sem o campo continua válido", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-assembly-text-"));
    await writeCredentials(dir, { preset: "custom", apiKey: "muse", model: "muse", baseUrl: "https://meta.example/v1", openaiApiKey: "luna", assemblyTextProvider: "openai" });
    expect(await readCredentials(dir)).toMatchObject({ assemblyTextProvider: "openai" });
    await writeCredentials(dir, { preset: "gemini", apiKey: "nova" });
    expect(await readCredentials(dir)).toEqual({ preset: "gemini", apiKey: "nova", openaiApiKey: "luna", assemblyTextProvider: "openai" });
    const path = credentialsPath(dir);
    await writeFile(path, JSON.stringify({ preset: "gemini", apiKey: "sem-campo-novo" }));
    await chmod(path, 0o600);
    expect(await readCredentials(dir)).toEqual({ preset: "gemini", apiKey: "sem-campo-novo" });
    const after = await writeCredentials(dir, { preset: "gemini", apiKey: "sem-campo-novo", typesafe: true });
    await expectPrivate(after);
    expect(await readCredentials(dir)).not.toHaveProperty("assemblyTextProvider");
  });

  it("recusa valor fora de openai/text e não grava o inválido", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-assembly-text-invalid-"));
    const path = credentialsPath(dir);
    await mkdir(join(dir, ".decupa"), { recursive: true });
    await writeFile(path, JSON.stringify({ preset: "zai", apiKey: "k", assemblyTextProvider: "sol-direto" }));
    await chmod(path, 0o600);
    expect(await readCredentials(dir)).not.toHaveProperty("assemblyTextProvider");
  });
  it("grava e lê sem logar a chave", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-"));
    const path = await writeCredentials(dir, {
      preset: "minimax",
      model: "MiniMax-M2",
      baseUrl: "https://api.minimax.io/v1/chat/completions",
      apiKey: "segredo-teste",
    });
    expect(path).toBe(credentialsPath(dir));
    await expectPrivate(path);
    const loaded = await readCredentials(dir);
    expect(loaded?.preset).toBe("minimax");
    expect(loaded?.apiKey).toBe("segredo-teste");
    const disk = await readFile(path, "utf8");
    expect(disk).toContain("segredo-teste");
  });

  it("devolve null quando não há arquivo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-"));
    expect(await readCredentials(dir)).toBeNull();
  });

  it("recusa diretório relativo", () => {
    expect(() => credentialsPath("projeto")).toThrow(/absoluto/);
  });

  it("restringe permissões existentes antes de reescrever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-"));
    const path = credentialsPath(dir);
    await writeCredentials(dir, { preset: "zai" });
    if (process.platform === "win32") {
      await run("icacls.exe", [path, "/grant", "*S-1-1-0:R"], windowsCommandOptions);
    } else {
      await chmod(path, 0o644);
    }
    await writeCredentials(dir, { preset: "zai", apiKey: "nova" });
    await expectPrivate(path);
    expect((await readCredentials(dir))?.apiKey).toBe("nova");
  });

  it("grava e conserva a chave do Jev ao reescrever só a análise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-cred-jev-"));
    await writeCredentials(dir, {
      preset: "zai",
      apiKey: "analise",
      typesafeApiKey: "jev-secret",
      typesafe: true,
    });
    expect((await readCredentials(dir))?.typesafeApiKey).toBe("jev-secret");
    await writeCredentials(dir, { preset: "gemini", apiKey: "outra" });
    expect(await readCredentials(dir)).toEqual({
      preset: "gemini",
      apiKey: "outra",
      typesafeApiKey: "jev-secret",
      typesafe: true,
    });
  });
});

it.runIf(process.platform === "win32")("não sobrescreve chave se a proteção Windows falhar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-cred-failure-"));
  const path = await writeCredentials(dir, { preset: "zai", apiKey: "anterior" });
  const before = await readFile(path, "utf8");
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = "";
    await expect(writeCredentials(dir, { preset: "zai", apiKey: "nova" })).rejects.toThrow(/chave não gravada/);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
  expect(await readFile(path, "utf8")).toBe(before);
});
