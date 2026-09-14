import { spawn } from "node:child_process";

/**
 * Python do motor de condense. `DECUPA_ENGINE_PYTHON` é o override do
 * ambiente do processo (o launcher e o setup apontam para o venv local);
 * sem ele, cai no python do PATH por plataforma. Não altera nada persistido.
 */
export function enginePython(env = process.env, platform = process.platform): string {
  return env.DECUPA_ENGINE_PYTHON || (platform === "win32" ? "python" : "python3");
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
 * inteiro; se o grupo não existir, tenta o PID direto.
 */
export function terminateTree(pid: number, platform = process.platform): void {
  if (platform === "win32") {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    child.on("error", () => { try { process.kill(pid); } catch { /* já saiu */ } });
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* já saiu */ } }
}
