import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Provider, StoredProvider } from "./provider.ts";

export type Credentials = StoredProvider & { apiKey?: string };

const FILE = "credentials";
const run = promisify(execFile);

// chmod não restringe ACLs no Windows. Nenhum segredo é enviado ao PowerShell.
const RESTRICT_WINDOWS_FILE = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $env:DECUPA_CREDENTIAL_FILE
$acl.SetAccessRuleProtection($true, $false)
foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:DECUPA_CREDENTIAL_FILE -AclObject $acl
$actual = Get-Acl -LiteralPath $env:DECUPA_CREDENTIAL_FILE
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or
    ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'ACL restrita não confirmada'
}
`;


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
  if (process.platform === "win32") {
    // Cria somente arquivo vazio; restringe antes de truncar/gravar uma chave.
    const empty = await open(path, "a");
    await empty.close();
    try {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", RESTRICT_WINDOWS_FILE], {
        env: { ...process.env, DECUPA_CREDENTIAL_FILE: path },
        windowsHide: true,
        timeout: 15_000,
      });
    } catch (cause) {
      throw new Error("não foi possível restringir a ACL das credenciais; chave não gravada", { cause });
    }
  }
  try {
    await chmod(path, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fh = await open(path, "w", 0o600);
  try {
    await fh.chmod(0o600);
    await fh.writeFile(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  } finally {
    await fh.close();
  }
  return path;
}
