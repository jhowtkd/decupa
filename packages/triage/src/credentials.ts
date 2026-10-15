import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AssemblyTextProvider, Provider, StoredProvider, VisualProvider } from "./provider.ts";
import { isRestrictedSddlAcl, parseIcaclsSaveOutput, parseWhoamiUserSid, resolveSddlSid } from "./windows-acl.ts";

export type Credentials = StoredProvider & {
  apiKey?: string;
  /** Chave do Jev (TypeSafe). Independente da chave de análise. */
  typesafeApiKey?: string;
  /** Equivale a DECUPA_TYPESAFE=1 persistido neste usuário. */
  typesafe?: boolean;
  openaiApiKey?: string;
  visualProvider?: VisualProvider;
  assemblyTextProvider?: AssemblyTextProvider;
};

const FILE = "credentials";
const run = promisify(execFile);

const WINDOWS_COMMAND_OPTIONS: ExecFileOptions = {
  shell: false,
  windowsHide: true,
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
};

export type WindowsCommandRunner = (executable: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>;

const runWindowsCommand: WindowsCommandRunner = async (executable, args, options) => {
  const result = await run(executable, args, { ...options, encoding: "utf8" });
  return { stdout: result.stdout.toString() };
};

export async function readWindowsAcl(path: string, execute: WindowsCommandRunner = runWindowsCommand): Promise<ReturnType<typeof parseIcaclsSaveOutput>> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "decupa-icacls-"));
  const savePath = join(temporaryDirectory, "acl.txt");
  try {
    await execute("icacls.exe", [path, "/save", savePath], WINDOWS_COMMAND_OPTIONS);
    const saved = await readFile(savePath);
    try {
      return parseIcaclsSaveOutput(saved);
    } catch (error) {
      // A SDDL não tem segredo; o trecho evita depurar o formato às cegas.
      const sample = JSON.stringify(saved.subarray(0, 240).toString("latin1"));
      throw new Error(`ACL do Windows não interpretável: ${sample}`, { cause: error });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * ACLs do Windows não são reduzidas por chmod. O arquivo já existe vazio para
 * que nenhuma chave atravesse a janela entre criação e restrição.
 */
export async function restrictWindowsCredentials(path: string, execute: WindowsCommandRunner = runWindowsCommand): Promise<void> {
  const { stdout: whoami } = await execute("whoami.exe", ["/user", "/fo", "csv", "/nh"], WINDOWS_COMMAND_OPTIONS);
  const sid = parseWhoamiUserSid(whoami);
  const grant = [path, "/inheritance:r", "/grant:r", `*${sid}:F`];
  await execute("icacls.exe", grant, WINDOWS_COMMAND_OPTIONS);

  let acl = await readWindowsAcl(path, execute);
  if (!isRestrictedSddlAcl(acl, sid)) {
    // /grant:r troca a concessão do SID informado, mas não remove outras
    // entradas explícitas. A SDDL fornece os SIDs sem depender do idioma.
    const removed = new Set<string>();
    const removals = acl.entries.map(entry => {
      const entrySid = resolveSddlSid(entry, sid);
      if (!entrySid) throw new Error(`ACE SDDL sem SID não pode ser restringida: ${acl.sddl}`);
      const operation = entry.type === "A" ? "/remove:g" : "/remove:d";
      return { operation, identity: `*${entrySid}` };
    });
    for (const { operation, identity } of removals) {
      const key = `${operation}\0${identity}`;
      if (removed.has(key)) continue;
      removed.add(key);
      await execute("icacls.exe", [path, operation, identity], WINDOWS_COMMAND_OPTIONS);
    }
    await execute("icacls.exe", grant, WINDOWS_COMMAND_OPTIONS);
    acl = await readWindowsAcl(path, execute);
  }
  if (!isRestrictedSddlAcl(acl, sid)) throw new Error(`ACL restrita não confirmada: ${acl.sddl}`);
}


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
  if (typeof rec.typesafeApiKey === "string" && rec.typesafeApiKey.length > 0) {
    out.typesafeApiKey = rec.typesafeApiKey;
  }
  if (typeof rec.typesafe === "boolean") out.typesafe = rec.typesafe;
  if (typeof rec.openaiApiKey === "string" && rec.openaiApiKey.trim()) out.openaiApiKey = rec.openaiApiKey.trim();
  if (rec.visualProvider === "openai" || rec.visualProvider === "text") out.visualProvider = rec.visualProvider;
  if (rec.assemblyTextProvider === "openai" || rec.assemblyTextProvider === "text") out.assemblyTextProvider = rec.assemblyTextProvider;
  return out;
}

export async function writeCredentials(dir: string, creds: Credentials,
  opts: { removeKeys?: ("openaiApiKey" | "typesafeApiKey")[] } = {}): Promise<string> {
  const path = credentialsPath(dir);
  await mkdir(join(resolve(dir), ".decupa"), { recursive: true });
  const previous = await readCredentials(dir).catch(() => null);
  const body: Credentials = { preset: creds.preset };
  if (creds.model) body.model = creds.model;
  if (creds.baseUrl) body.baseUrl = creds.baseUrl;
  if (creds.apiKey) body.apiKey = creds.apiKey;
  const typesafeApiKey = opts.removeKeys?.includes("typesafeApiKey") ? undefined : creds.typesafeApiKey ?? previous?.typesafeApiKey;
  if (typesafeApiKey) body.typesafeApiKey = typesafeApiKey;
  const typesafe = creds.typesafe ?? previous?.typesafe;
  if (typesafe !== undefined) body.typesafe = typesafe;
  const openaiApiKey = opts.removeKeys?.includes("openaiApiKey") ? undefined : creds.openaiApiKey ?? previous?.openaiApiKey;
  if (openaiApiKey) body.openaiApiKey = openaiApiKey;
  const visualProvider = creds.visualProvider ?? previous?.visualProvider;
  if (visualProvider) body.visualProvider = visualProvider;
  const assemblyTextProvider = creds.assemblyTextProvider ?? previous?.assemblyTextProvider;
  if (assemblyTextProvider) body.assemblyTextProvider = assemblyTextProvider;
  if (process.platform === "win32") {
    // Cria somente arquivo vazio; restringe antes de truncar/gravar uma chave.
    const empty = await open(path, "a");
    await empty.close();
    try {
      await restrictWindowsCredentials(path);
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
