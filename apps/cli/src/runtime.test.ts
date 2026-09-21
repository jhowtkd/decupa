import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { browserCommand, enginePython } from "./runtime.ts";
import { SpawnExecutor } from "./app/pipeline.ts";

it("usa Python explícito e preserva caminhos com espaços", () => {
  expect(enginePython({ DECUPA_ENGINE_PYTHON: "C:\\Decupa App\\python.exe" }, "win32"))
    .toBe("C:\\Decupa App\\python.exe");
});

it("Windows abre URL loopback sem interpolação em shell", () => {
  expect(browserCommand("http://127.0.0.1:7788", "win32")).toEqual({
    command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:7788"],
  });
  expect(browserCommand("https://example.com", "win32")).toBeNull();
});

// Lifecycle de verdade, não mock de plataforma: o mesmo teste vale no macOS e
// no Windows. A criação do spawn é síncrona, então killAll já vê o filho vivo
// antes da primeira espera; `run` precisa resolver com code != 0 em até 5s.
it("encerra processo iniciado pelo executor", async () => {
  const exec = new SpawnExecutor();
  const pending = exec.run({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  exec.killAll();
  expect((await pending).code).not.toBe(0);
}, 5000);

it("aborto encerra pai python e filho adormecido sem tocar outros processos", async () => {
  // Grupos de processo POSIX + pgrep: no Windows o taskkill /T cobre a árvore.
  if (process.platform === "win32") return;
  const { spawn, execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const token = `decupa-tree-${process.pid}-${Date.now()}`;
  const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
  const unrelatedPid = unrelated.pid!;
  try {
    const exec = new SpawnExecutor();
    const controller = new AbortController();
    const script = [
      "import subprocess,sys,time",
      `subprocess.Popen([sys.executable,"-c","import time;time.sleep(30) # ${token}-child"])`,
      `time.sleep(30) # ${token}-parent`,
    ].join("; ");
    const pending = exec.run({ command: "python3", args: ["-c", script], signal: controller.signal });
    let parent = "";
    let child = "";
    await vi.waitFor(async () => {
      const { stdout } = await run("pgrep", ["-f", `${token}-parent`]);
      parent = stdout.trim().split("\n")[0]!;
      expect(parent).toMatch(/^\d+$/);
      const { stdout: kids } = await run("pgrep", ["-P", parent]);
      child = kids.trim().split("\n")[0]!;
      expect(child).toMatch(/^\d+$/);
    }, { timeout: 8000 });
    controller.abort();
    expect((await pending).code).not.toBe(0);
    await vi.waitFor(() => {
      expect(() => process.kill(Number(parent), 0)).toThrow();
      expect(() => process.kill(Number(child), 0)).toThrow();
    }, { timeout: 5000 });
    expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
  } finally {
    try {
      process.kill(unrelatedPid, "SIGKILL");
    } catch {
      // Já saiu.
    }
  }
}, 15000);

it("grupo que ignora SIGTERM recebe SIGKILL após 2s", async () => {
  if (process.platform === "win32") return;
  const exec = new SpawnExecutor();
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = exec.run({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);"],
    onLine: (line) => {
      if (line.includes("ready")) ready();
    },
  });
  await isReady;
  const start = Date.now();
  exec.killAll();
  expect((await pending).code).not.toBe(0);
  expect(Date.now() - start).toBeGreaterThanOrEqual(1500);
}, 15000);

it("openBrowser trata falha do spawn sem lançar erro não tratado", async () => {
  let captured: EventEmitter | undefined;
  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
      ...actual,
      spawn: () => {
        captured = new EventEmitter();
        (captured as { unref?: () => void }).unref = () => {};
        return captured;
      },
    };
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { openBrowser } = await import("./runtime.ts");
    expect(() => openBrowser("http://127.0.0.1:7788")).not.toThrow();
    // O handler já está registrado; emitir `error` sem handler lançaria.
    captured!.emit("error", new Error("ENOENT"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Abra manualmente"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:7788"));
  } finally {
    errors.mockRestore();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});
