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
