import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const transcribeSpy = vi.hoisted(() => vi.fn(async () => ({ language: "pt", words: [], unaligned: [] })));

vi.mock("@decupa/transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@decupa/transcript")>()),
  createResidentSpeechClient: () => ({
    transcribe: transcribeSpy,
    cancel: () => {},
    close: async () => undefined,
  }),
}));

const server = await import("./server.ts");

const dirs: string[] = [];
afterEach(async () => {
  transcribeSpy.mockClear();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const req = { taskId: "t", wav: "x.wav", language: "pt" };

// A montagem não passa pelo preflight da limpeza: o worker residente tem de
// conferir o venv da fala antes de transcrever, e só cachear o sucesso.
it.skipIf(process.platform === "win32")("speech.worker confere o venv: falha não fica em cache, sucesso fica", async () => {
  const dir = await mkdtemp(join(tmpdir(), "speech-worker-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const log = join(dir, "argv.log");
  const codeFile = join(dir, "code");
  await writeFile(codeFile, "1");
  // Shebang com o node absoluto: o PATH do teste só tem o falso.
  await writeFile(join(bin, "uv"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.DECUPA_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(Number(fs.readFileSync(process.env.DECUPA_CODE_FILE, "utf8")));
`, "utf8");
  await chmod(join(bin, "uv"), 0o755);
  const previous = process.env.PATH;
  process.env.DECUPA_ARGV_LOG = log;
  process.env.DECUPA_CODE_FILE = codeFile;
  process.env.PATH = bin;
  try {
    const { speech } = server.attachResidentSpeech({ dir, executorInjected: false });
    const worker = speech!.worker!;
    const syncs = async () =>
      (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter((l) => l.includes("sync")).length;

    // 1: sync falha -> setup, e o cliente nem é chamado.
    await expect(worker(req)).rejects.toThrow(/node scripts\/setup\.mjs/);
    expect(transcribeSpy).not.toHaveBeenCalled();

    // 2: a falha não ficou em cache.
    await writeFile(codeFile, "0");
    await worker(req);
    expect(transcribeSpy).toHaveBeenCalledTimes(1);

    // 3: o sucesso ficou em cache — nenhum sync novo (1 falha + 1 sucesso).
    await worker(req);
    expect(transcribeSpy).toHaveBeenCalledTimes(2);
    expect(await syncs()).toBe(2);
  } finally {
    process.env.PATH = previous;
    delete process.env.DECUPA_ARGV_LOG;
    delete process.env.DECUPA_CODE_FILE;
  }
});
