import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Script constante: sem interpolação de path ou input do usuário. */
export const SELECT_SCRIPT = `
set AppleScript's text item delimiters to linefeed
try
  set theFiles to choose file with prompt "Escolher mídia para a montagem" with multiple selections allowed
on error number -128
  return "CANCEL"
end try
set posixPaths to {}
repeat with f in theFiles
  set end of posixPaths to POSIX path of f
end repeat
return posixPaths as text
`.trim();

export type SelectResult = { cancelled: true } | { paths: string[] };

export async function selectLocalFiles(
  exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = defaultExec,
): Promise<SelectResult> {
  const result = await exec("osascript", ["-e", SELECT_SCRIPT]);
  if (result.code !== 0) {
    const err = `${result.stderr}\n${result.stdout}`;
    if (/-128/.test(err) || /\bCANCEL\b/.test(err)) return { cancelled: true };
    throw new Error(`seletor falhou: ${err.trim() || `código ${result.code}`}`);
  }
  const text = result.stdout.replace(/\r/g, "").trim();
  if (text === "CANCEL" || text === "") return { cancelled: true };
  const raw = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const paths: string[] = [];
  for (const item of raw) {
    const st = await lstat(item).catch(() => null);
    if (!st || !st.isFile()) throw new Error(`seleção inválida: ${item}`);
    paths.push(await realpath(item));
  }
  return { paths };
}

async function defaultExec(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await run(command, args);
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? failed.message ?? ""),
    };
  }
}
