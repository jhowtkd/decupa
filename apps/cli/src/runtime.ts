import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/cli/src -> raiz do repositório, onde o setup cria work/engine-venv. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Python do motor de condense. `DECUPA_ENGINE_PYTHON` é o override do
 * ambiente do processo (o launcher e o setup apontam para o venv local).
 * Sem ele, vale o `work/engine-venv` do setup quando existe: `pnpm decupa`
 * e as skills rodam fora do launcher, e o python do PATH numa máquina limpa
 * não tem cv2, numpy nem scenedetect. Só sem venv cai no python do PATH.
 * Não altera nada persistido.
 */
export function enginePython(env = process.env, platform = process.platform, root = REPO_ROOT): string {
  if (env.DECUPA_ENGINE_PYTHON) return env.DECUPA_ENGINE_PYTHON;
  const venv = join(root, "work", "engine-venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (existsSync(venv)) return venv;
  return platform === "win32" ? "python" : "python3";
}

/**
 * Comando para abrir o navegador numa URL loopback, sem shell e sem
 * interpolação. Só 127.0.0.1 passa: é a única origem que o servidor local
 * produz; qualquer outra string volta `null` e nada é executado.
 */
export function browserCommand(
  url: string,
  platform = process.platform,
): { command: string; args: string[] } | null {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(url)) return null;
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Abre o navegador sem derrubar o servidor se falhar: `open`/`xdg-open` pode
 * não existir (Linux mínimo, Windows sem rundll32), e a tela continua
 * acessível pela URL impressa no console.
 */
export function openBrowser(url: string): void {
  const call = browserCommand(url);
  if (!call) return;
  const child = spawn(call.command, call.args, { stdio: "ignore", detached: true });
  child.on("error", () => console.error(`Abra manualmente: ${url}`));
  child.unref();
}

/**
 * Encerra a árvore de um processo criado por este executor. No Windows,
 * `taskkill /PID <pid> /T /F` atua somente no PID criado aqui e ainda vivo —
 * nunca `/IM`, que mataria qualquer processo com o mesmo nome. No POSIX, o
 * filho é líder de grupo (spawn detached) e o SIGTERM vai para o grupo
 * inteiro; se o grupo não existir, tenta o PID direto. Grupo que sobrevive
 * recebe SIGKILL após 2s — nunca `pkill` global.
 */
export function terminateTree(pid: number, platform = process.platform): void {
  if (platform === "win32") {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    child.on("error", () => { try { process.kill(pid); } catch { /* já saiu */ } });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* já saiu */ } }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, 0);
    } catch {
      return; // Árvore já saiu: nada a escalar.
    }
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* já saiu */ } }
  }, 2000);
  escalate.unref?.();
}

/** O grupo POSIX ainda tem algum membro vivo? (sinal 0 só sonda) */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGKILL síncrono no grupo (ou no PID, se o grupo não existir). No Windows o
 *  taskkill /F já é forçado. Serve ao handler de `exit`, que só roda código
 *  síncrono e não tem como esperar timer nenhum. */
export function killTreeNow(pid: number, platform = process.platform): void {
  if (platform === "win32") {
    terminateTree(pid, platform);
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* já saiu */ } }
}

/**
 * Como `terminateTree`, mas a promessa só resolve quando a árvore saiu. O
 * SIGKILL depois da carência não pode ficar num timer solto: o `shutdown` do
 * CLI chama `process.exit` logo em seguida e a escalada nunca dispararia, com
 * o filho que ignora SIGTERM sobrevivendo ao encerramento. O sinal vai
 * sincronamente, antes do primeiro `await`.
 */
export async function terminateTreeAndWait(
  pid: number,
  graceMs = 2000,
  platform = process.platform,
): Promise<void> {
  if (platform === "win32") {
    await new Promise<void>((done) => {
      const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      child.on("error", () => { try { process.kill(pid); } catch { /* já saiu */ } done(); });
      child.on("exit", () => done());
    });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* já saiu */ } }
  const wait = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (groupAlive(pid)) {
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  };
  if (await wait(graceMs)) return;
  killTreeNow(pid, platform);
  await wait(1000);
}
