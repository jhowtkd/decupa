import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { alignText, transcribe } from "./transcribe.ts";

// `uv` falso: registra os args e sai com DECUPA_SYNC_CODE quando é `sync`.
// O shebang é o node absoluto, porque o PATH do teste só tem os falsos.
async function comUvFalso(
  syncCode: number,
  body: (log: () => Promise<string[][]>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sync-guard-"));
  const logFile = join(dir, "argv.log");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const script = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.DECUPA_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("sync")) process.exit(Number(process.env.DECUPA_SYNC_CODE));
if (process.argv.includes("transcribe.py")) {
  process.stdout.write(JSON.stringify({
    language: "pt",
    words: [{ text: "ola", startMs: 0, endMs: 40 }],
  }) + "\\n");
}
process.exit(0);
`;
  for (const name of ["ffmpeg", "uv"]) {
    const path = join(bin, name);
    await writeFile(path, script, "utf8");
    await chmod(path, 0o755);
  }
  const previous = process.env.PATH;
  process.env.DECUPA_ARGV_LOG = logFile;
  process.env.DECUPA_SYNC_CODE = String(syncCode);
  process.env.PATH = bin;
  try {
    await body(async () => {
      const text = await readFile(logFile, "utf8").catch(() => "");
      return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    });
  } finally {
    process.env.PATH = previous;
    delete process.env.DECUPA_ARGV_LOG;
    delete process.env.DECUPA_SYNC_CODE;
    await rm(dir, { recursive: true, force: true });
  }
}

const temRun = (calls: string[][]) => calls.some((args) => args.includes("run"));
const temSync = (calls: string[][]) => calls.some((args) => args.includes("sync"));

// Sem o venv da fala sincronizado, `uv run` (mesmo com --no-sync) não deve
// nem começar: o erro tem de mandar rodar o setup, em vez de um traceback.
it("alignText com o venv da fala fora de sincronia manda rodar o setup e não chama uv run", async () => {
  await comUvFalso(1, async (log) => {
    const erro = await alignText({ input: "x", text: "ola", startSeconds: 0, endSeconds: 1 })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(erro?.message).toMatch(/node scripts\/setup\.mjs/);
    expect(erro?.message).toContain("fala");
    const calls = await log();
    expect(temSync(calls)).toBe(true);
    expect(temRun(calls)).toBe(false);
  });
});

it("transcribe sem worker com o venv da fala fora de sincronia manda rodar o setup e não chama uv run", async () => {
  await comUvFalso(1, async (log) => {
    const erro = await transcribe({ input: "x" }, { extract: async () => undefined })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(erro?.message).toMatch(/node scripts\/setup\.mjs/);
    expect(erro?.message).toContain("fala");
    const calls = await log();
    expect(temSync(calls)).toBe(true);
    expect(temRun(calls)).toBe(false);
  });
});

// Contraste: sync ok segue para o uv run.
it("com o venv da fala sincronizado o fluxo chega ao uv run", async () => {
  await comUvFalso(0, async (log) => {
    await alignText({ input: "x", text: "ola", startSeconds: 0, endSeconds: 1 });
    const calls = await log();
    expect(temRun(calls)).toBe(true);
  });
});
