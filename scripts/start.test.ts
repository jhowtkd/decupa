import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { main, startArgs } from "./start.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_REL = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";

const exists = (path: string) => access(path).then(() => true, () => false);

/** Porta livre de verdade: o SO escolhe, o teste libera antes do CLI ocupar. */
async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
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

it("abre o Decupa com um comando, exige provedor antes de GET /project e encerra no sinal", async () => {
  const port = await ephemeralPort();
  const projectDir = await mkdtemp(join(tmpdir(), "decupa start ")); // caminho com espaços
  // PATH vazio: o CLI tenta openBrowser e o `open`/`xdg-open` não é
  // encontrado — nenhum navegador real abre durante o teste.
  const pathVazio = await mkdtemp(join(tmpdir(), "decupa path-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  for (const key of ["DECUPA_COMPANY_API_KEY", "ZAI_API_KEY", "GEMINI_API_KEY", "MINIMAX_API_KEY", "DECUPA_API_KEY"]) delete env[key];
  env.PATH = pathVazio;
  env.HOME = pathVazio;
  env.USERPROFILE = pathVazio;

  // O launcher só confere access() no Python do venv; o CLI não o executa no
  // boot do montar. Se não houver venv real, cria um placeholder e remove no
  // finally exatamente o que criou — nunca apaga um venv de verdade.
  const venvPython = join(ROOT, "work/engine-venv", PYTHON_REL);
  const placeholderCriado = !(await exists(venvPython));
  if (placeholderCriado) {
    await mkdir(dirname(venvPython), { recursive: true });
    await writeFile(venvPython, "placeholder de teste\n", "utf8");
  }

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [
      join(ROOT, "scripts", "start.mjs"), "--project", projectDir, "--port", String(port),
    ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    const saida: string[] = [];
    child.stdout!.on("data", (d) => saida.push(String(d)));
    child.stderr!.on("data", (d) => saida.push(String(d)));

    const base = `http://127.0.0.1:${port}`;
    // Prazo total do teste: 10 s; o boot fica em 8 s para o término e a
    // checagem de porta fechada caberem no orçamento.
    const limite = Date.now() + 8_000;
    let corpo: { error?: string } | null = null;
    while (Date.now() < limite) {
      if (child.exitCode !== null) break; // morreu no caminho; falha com a saída abaixo
      try {
        const res = await fetch(`${base}/project`, { signal: AbortSignal.timeout(1_000) });
        if (res.status === 428) { corpo = (await res.json()) as typeof corpo; break; }
      } catch { /* ainda subindo */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(corpo, `o servidor não subiu; saída:\n${saida.join("")}`).not.toBeNull();
    expect(corpo!.error).toContain("Configure o provedor");
    expect(await (await fetch(base)).text()).toContain("Configure a IA do Decupa");

    const saiu = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
    child.kill("SIGTERM");
    const code = await saiu;
    // No POSIX o CLI faz shutdown gracioso e sai 0; no Windows o SIGTERM
    // emulado encerra sem código gracioso — a Task 6 valida o console real.
    if (process.platform !== "win32") expect(code).toBe(0);

    let portaFechada = false;
    try {
      await fetch(`${base}/project`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      portaFechada = true;
    }
    expect(portaFechada, "a porta continuou aberta após o término").toBe(true);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (placeholderCriado) {
      await rm(venvPython, { force: true });
      // Remove só os diretórios que o teste criou e só se vazios; um venv
      // real (Task 6 roda o setup de verdade depois) nunca é tocado.
      for (const dir of [dirname(venvPython), join(ROOT, "work/engine-venv"), join(ROOT, "work")]) {
        await rmdir(dir).catch(() => {});
      }
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(pathVazio, { recursive: true, force: true });
  }
}, 10_000);
