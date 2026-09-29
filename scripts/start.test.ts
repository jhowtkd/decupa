import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { main, startArgs } from "./start.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_REL = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
const START_URL = pathToFileURL(join(ROOT, "scripts/start.mjs")).href;

/** Porta livre de verdade: o SO escolhe, o teste libera antes do CLI ocupar. */
async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/**
 * Root só de teste: o Python do motor é um arquivo vazio (o launcher só faz
 * access) e apps/node_modules são symlinks do repositório. Nada é escrito em
 * `<repo>/work` — um placeholder lá seria executado por enginePython().
 */
async function launcherRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "decupa launcher "));
  const python = join(root, "work/engine-venv", PYTHON_REL);
  await mkdir(dirname(python), { recursive: true });
  await writeFile(python, "");
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(join(ROOT, "apps"), join(root, "apps"), kind);
  await symlink(join(ROOT, "node_modules"), join(root, "node_modules"), kind);
  return root;
}

/** PATH vazio e sem chaves: o `open` não existe e nenhuma credencial é gravada. */
async function ambienteIsolado(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "decupa path-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" || /key|token|secret|password|credential/i.test(key)) delete env[key];
  }
  env.PATH = dir;
  env.HOME = dir;
  env.USERPROFILE = dir;
  return { env, dir };
}

/**
 * Launcher em processo próprio e grupo próprio (`detached`). O CLI nasce no
 * mesmo grupo, então `kill(-pid)` imita o terminal sem atingir o vitest.
 */
function spawnLauncher(root: string, argv: string[], env: NodeJS.ProcessEnv, sidecarReady: string): ChildProcess {
  const script = `
    const m = await import(${JSON.stringify(START_URL)});
    await m.main(${JSON.stringify(root)}, ${JSON.stringify(argv)}, { sidecarReady: ${sidecarReady} });
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
}

function matarGrupo(child: ChildProcess | null): void {
  if (!child?.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* já saiu */ } }
}

async function esperar428(port: number, child: ChildProcess, saida: string[]): Promise<void> {
  const limite = Date.now() + 12_000;
  while (Date.now() < limite) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/project`, { signal: AbortSignal.timeout(1_000) });
      if (res.status === 428) return;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`o servidor não subiu; saída:\n${saida.join("")}`);
}

async function portaFechada(port: number): Promise<boolean> {
  const limite = Date.now() + 2_000;
  while (Date.now() < limite) {
    try {
      await fetch(`http://127.0.0.1:${port}/project`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

it("preserva argumento com espaços sem shell", () => {
  expect(startArgs(["--project", "/tmp/Meu Projeto"])).toEqual(["montar", "--project", resolve("/tmp/Meu Projeto")]);
  expect(() => startArgs(["--project", "/tmp/a", "--input", "/tmp/b"])).toThrow();
  expect(() => startArgs(["--project", "/tmp/a", "--port", "0"])).toThrow();
});

it("traduz --input em limpar e anexa porta válida", () => {
  expect(startArgs(["--input", "/tmp/Meu Vídeo.mp4"])).toEqual(["limpar", "--input", resolve("/tmp/Meu Vídeo.mp4")]);
  expect(startArgs(["--project", "/tmp/p", "--port", "7788"])).toEqual([
    "montar", "--project", resolve("/tmp/p"), "--port", "7788",
  ]);
});

it("recusa duas fontes, flags pagas e porta fora de 1–65535", () => {
  expect(() => startArgs([])).toThrow();
  expect(() => startArgs(["--project", "/tmp/p", "--allow-paid-model"])).toThrow();
  expect(() => startArgs(["--project", "/tmp/p", "--allow-paid-visual"])).toThrow();
  expect(() => startArgs(["--project", "/tmp/p", "--port", "65536"])).toThrow();
  expect(() => startArgs(["--project", "/tmp/p", "--port", "abc"])).toThrow();
});

it("sem runtime local, falha orientando executar o setup", async () => {
  // Root temporário com caminho com espaços: prova a mensagem sem tocar no
  // work/ do repositório (main aceita root opcional justamente para isso).
  // O Python falta antes de node_modules, e node_modules falta antes dos
  // sidecars — a checagem do uv não chega a rodar.
  const root = await mkdtemp(join(tmpdir(), "decupa sem runtime "));
  try {
    await expect(main(root, ["--project", join(root, "projeto")]))
      .rejects.toThrow(/Python do motor/);
    await expect(main(root, ["--project", join(root, "projeto")]))
      .rejects.toThrow(/node scripts\/setup\.mjs/);
    const python = join(root, "work/engine-venv", PYTHON_REL);
    await mkdir(dirname(python), { recursive: true });
    await writeFile(python, "placeholder de teste\n", "utf8");
    await expect(main(root, ["--project", join(root, "projeto")]))
      .rejects.toThrow(/node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("recusa o sidecar de fala incompleto antes de subir o CLI", async () => {
  const root = await launcherRoot();
  const projectDir = await mkdtemp(join(tmpdir(), "decupa start "));
  const { env, dir: pathVazio } = await ambienteIsolado();
  const port = await ephemeralPort();
  // Terceiro argumento injetável: false reprova sem chamar `uv sync`.
  const child = spawnLauncher(root, ["--project", projectDir, "--port", String(port)], env, "async () => false");
  const saida: string[] = [];
  child.stderr!.on("data", (d) => saida.push(String(d)));
  child.stdout!.on("data", (d) => saida.push(String(d)));
  try {
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(child.exitCode), 4_000);
      child.once("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    const texto = saida.join("");
    expect(texto, texto).toMatch(/Ambiente Python de fala/);
    expect(texto).toMatch(/node scripts\/setup\.mjs/);
    expect(code).toBe(1);
  } finally {
    matarGrupo(child);
    await rm(root, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(pathVazio, { recursive: true, force: true });
  }
});

// O launcher ignora SIGINT (o CLI já recebeu o do terminal) e repassa
// SIGTERM/SIGHUP. No prefix o SIGINT era repassado e o CLI saía com 1.
async function encerraNoSinal(sinal: "SIGINT" | "SIGHUP" | "SIGTERM"): Promise<void> {
  const port = await ephemeralPort();
  const projectDir = await mkdtemp(join(tmpdir(), "decupa start "));
  const root = await launcherRoot();
  const { env, dir: pathVazio } = await ambienteIsolado();
  const child = spawnLauncher(root, ["--project", projectDir, "--port", String(port)], env, "async () => true");
  const saida: string[] = [];
  child.stdout!.on("data", (d) => saida.push(String(d)));
  child.stderr!.on("data", (d) => saida.push(String(d)));
  try {
    await esperar428(port, child, saida);
    const saiu = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`não encerrou; saída:\n${saida.join("")}`)), 8_000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (sinal === "SIGTERM") child.kill("SIGTERM");
    else process.kill(-child.pid!, sinal);
    expect(await saiu).toBe(0);
    expect(await portaFechada(port), "a porta continuou aberta após o término").toBe(true);
  } finally {
    matarGrupo(child);
    await rm(root, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(pathVazio, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("SIGINT no grupo encerra o CLI uma vez só e fecha a porta", async () => {
  await encerraNoSinal("SIGINT");
}, 20_000);

it.skipIf(process.platform === "win32")("SIGHUP no grupo encerra o CLI e fecha a porta", async () => {
  await encerraNoSinal("SIGHUP");
}, 20_000);

it.skipIf(process.platform === "win32")("SIGTERM só no launcher é repassado e fecha a porta", async () => {
  await encerraNoSinal("SIGTERM");
}, 20_000);
