import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import {
  assertSidecarSynced, preflight, runIngest, SpawnExecutor,
  type ExecCall, type ExecResult, type Executor,
} from "./pipeline.ts";

const SPEECH = join(dirname(fileURLToPath(import.meta.url)), "../../../../services/speech");

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Grava as chamadas; `uv sync` devolve `syncCode`, o resto devolve 0. */
function recorder(syncCode: number): Executor & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async run(call: ExecCall): Promise<ExecResult> {
      calls.push(call);
      return { code: call.args.includes("sync") ? syncCode : 0, stdout: "", stderr: "" };
    },
  };
}

// Sem conferir o venv, `uv run` (com --no-sync) só falha lá na etapa, com um
// ModuleNotFoundError que ninguém liga ao setup.
describe("preflight recusa sidecar de fala sem ambiente", () => {
  async function fakeEngine(): Promise<string> {
    const engine = await tmp("sidecar-motor-");
    const tools = join(engine, "mcp", "ve_tools");
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, "condense.py"), "# motor de mentira\n");
    await writeFile(join(tools, "condense_lang.py"), '_TERMINAL_PUNCT = ".!?"\nFILLERS_SOFT_PT = ["tipo"]\n');
    return engine;
  }
  async function comMotor<T>(fn: () => Promise<T>): Promise<T> {
    const before = process.env.VE_PLUGIN_ROOT;
    process.env.VE_PLUGIN_ROOT = await fakeEngine();
    try { return await fn(); }
    finally {
      if (before === undefined) delete process.env.VE_PLUGIN_ROOT;
      else process.env.VE_PLUGIN_ROOT = before;
    }
  }
  const job = { id: "j", videoPath: join(FIXTURES, "clip.mp4"), workDir: tmpdir() };

  it("uv sync --check falhando manda rodar o setup e cita a fala", async () => {
    const error = await comMotor(() => preflight(job, recorder(1))).then(() => null, (e: Error) => e);
    expect(error, "preflight devia lançar").not.toBeNull();
    expect(error!.message).toMatch(/node scripts\/setup\.mjs/);
    expect(error!.message).toMatch(/fala/);
  });

  it("contraste: com o ambiente em dia, resolve", async () => {
    await expect(comMotor(() => preflight(job, recorder(0)))).resolves.toBeUndefined();
  });
});

const temUv = spawnSync("uv", ["--version"]).status === 0;

describe.skipIf(!temUv)("assertSidecarSynced com uv real", () => {
  async function sidecarSemVenv(): Promise<string> {
    const dir = await tmp("sidecar-fala-");
    await copyFile(join(SPEECH, "pyproject.toml"), join(dir, "pyproject.toml"));
    await copyFile(join(SPEECH, "uv.lock"), join(dir, "uv.lock"));
    return dir;
  }

  it("recusa e não cria .venv", async () => {
    const dir = await sidecarSemVenv();
    await expect(assertSidecarSynced(new SpawnExecutor(), dir, "fala"))
      .rejects.toThrow(/node scripts\/setup\.mjs/);
    expect(await stat(join(dir, ".venv")).then(() => true, () => false)).toBe(false);
  }, 60_000);

  it(".venv vazio continua recusado e intocado", async () => {
    const dir = await sidecarSemVenv();
    await mkdir(join(dir, ".venv"));
    await expect(assertSidecarSynced(new SpawnExecutor(), dir, "fala"))
      .rejects.toThrow(/node scripts\/setup\.mjs/);
    expect(await readdir(join(dir, ".venv"))).toEqual([]);
  }, 60_000);
});

describe("etapa visual do ingest", () => {
  it("sidecar de visão sem ambiente vira warning, sem proxy e sem visual_index.py", async () => {
    const workDir = await tmp("sidecar-visual-");
    await writeFile(
      join(workDir, "transcript.json"),
      JSON.stringify({ segments: [{ start: 0, end: 1, text: "oi" }] }),
    );
    const exec = recorder(1);
    const result = await runIngest(
      { id: "j", videoPath: join(FIXTURES, "clip.mp4"), workDir },
      exec, () => {}, undefined, undefined, undefined, undefined, { visual: true },
    );
    expect(result.warning).toMatch(/setup\.mjs/);
    expect(exec.calls.some((c) => c.args.includes("visual_index.py"))).toBe(false);
    expect(exec.calls.some((c) => c.command === "ffmpeg")).toBe(false);
  });
});
