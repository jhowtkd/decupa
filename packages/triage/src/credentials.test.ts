import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.ts";

const run = promisify(execFile);
async function windowsAcl(path: string, script: string): Promise<string> {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")), DECUPA_CREDENTIAL_FILE: path }, timeout: 15_000,
  });
  return stdout;
}

async function expectPrivate(path: string): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    return;
  }
  const output = await windowsAcl(path, `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:DECUPA_CREDENTIAL_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
@{ protected = $acl.AreAccessRulesProtected; count = $rules.Count;
   onlyUser = @($rules | Where-Object { $_.IdentityReference.Value -ne $sid -or $_.AccessControlType -ne 'Allow' }).Count -eq 0;
   fullControl = @($rules | Where-Object { ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl }).Count -eq 1
} | ConvertTo-Json -Compress
`);
  expect(JSON.parse(output)).toEqual({ protected: true, count: 1, onlyUser: true, fullControl: true });
}

describe("credentials", () => {
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
      await windowsAcl(path, `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:DECUPA_CREDENTIAL_FILE
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
Set-Acl -LiteralPath $env:DECUPA_CREDENTIAL_FILE -AclObject $acl
`);
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
