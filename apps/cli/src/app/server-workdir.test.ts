import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeExecutor } from "./pipeline.ts";
import { startApp } from "./server.ts";

const EXPORT_EDL = "export do usuário\n";
const ACTIVE = new Set(["queued", "transcribing", "indexing", "visual", "planning"]);

/** Motor mínimo: só o que o preflight abre, com o léxico que o teste pede. */
async function writeFakeEngine(terminalPunct: string): Promise<string> {
  const engine = await mkdtemp(join(tmpdir(), "motor-"));
  const tools = join(engine, "mcp", "ve_tools");
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, "condense.py"), "# motor de mentira\n", "utf8");
  await writeFile(
    join(tools, "condense_lang.py"),
    `_TERMINAL_PUNCT = "${terminalPunct}"\n_CLAUSE_PUNCT = "，,、；;：:"\nFILLERS_SOFT_PT = ["tipo", "né", "tá"]\n`,
    "utf8",
  );
  return engine;
}

let engine = "";
let previousEngine: string | undefined;

beforeAll(async () => {
  engine = await writeFakeEngine(".。！？!?…");
});

beforeEach(() => {
  previousEngine = process.env.VE_PLUGIN_ROOT;
  process.env.VE_PLUGIN_ROOT = engine;
});

afterEach(() => {
  if (previousEngine === undefined) delete process.env.VE_PLUGIN_ROOT;
  else process.env.VE_PLUGIN_ROOT = previousEngine;
});

async function waitSettled(app: { port: number; jobId: string }): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = "sem resposta";
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${app.port}/jobs/${app.jobId}`);
    const body = await res.json() as { stage?: string; error?: string };
    last = `${body.stage ?? "?"}${body.error ? `: ${body.error}` : ""}`;
    if (body.stage && !ACTIVE.has(body.stage)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error(`job não saiu do ingest (${last})`);
}

async function runCleanup(input: string, calls: string[]): Promise<void> {
  const app = await startApp({
    input,
    port: 0,
    executor: new FakeExecutor(),
    speech: {
      worker: async (req: { taskId: string; language: string }) => {
        calls.push(req.taskId);
        return {
          language: req.language,
          words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
    },
  });
  try {
    await waitSettled(app);
  } finally {
    await app.close();
  }
}

async function transcribeOnce(dir: string, input: string, calls: string[]): Promise<string> {
  await runCleanup(input, calls);
  expect(calls).toHaveLength(1);
  const names = (await readdir(dir)).filter((name) => name.startsWith(".decupa-"));
  expect(names).toHaveLength(1);
  const work = join(dir, names[0] ?? "");
  const transcript = await readFile(join(work, "transcript.json"), "utf8");
  await writeFile(join(work, "corte.edl"), EXPORT_EDL, "utf8");
  return transcript;
}

describe("cache da limpeza", () => {
  it("conteúdo trocado no mesmo caminho transcreve de novo e guarda a pasta antiga", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-swap-"));
    const input = join(dir, "aula.mp4");
    await writeFile(input, "A");
    const calls: string[] = [];
    const oldTranscript = await transcribeOnce(dir, input, calls);
    await writeFile(input, "BBBB");

    await runCleanup(input, calls);

    expect(calls).toHaveLength(2);
    const stales = (await readdir(dir)).filter((name) => name.startsWith(".decupa-aula.mp4.stale-"));
    expect(stales).toHaveLength(1);
    const stale = join(dir, stales[0] ?? "");
    expect(await readFile(join(stale, "transcript.json"), "utf8")).toBe(oldTranscript);
    expect(await readFile(join(stale, "corte.edl"), "utf8")).toBe(EXPORT_EDL);
    const oldSource = JSON.parse(await readFile(join(stale, "source.json"), "utf8")) as {
      path: string;
      size: number;
    };
    expect(oldSource.path).toBe(resolve(input));
    expect(oldSource.size).toBe(1);
    const fresh = JSON.parse(await readFile(join(dir, ".decupa-aula.mp4", "source.json"), "utf8")) as {
      path: string;
      size: number;
    };
    expect(fresh.path).toBe(resolve(input));
    expect(fresh.size).toBe(4);
  });

  it("mtime diferente com o mesmo tamanho transcreve de novo e guarda a pasta antiga", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-mtime-"));
    const input = join(dir, "aula.mp4");
    await writeFile(input, "AAAA");
    const calls: string[] = [];
    const oldTranscript = await transcribeOnce(dir, input, calls);
    const before = await stat(input);
    const shifted = new Date("2019-01-01T00:00:00.000Z");
    await utimes(input, shifted, shifted);
    const after = await stat(input);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);

    await runCleanup(input, calls);

    expect(calls).toHaveLength(2);
    const stales = (await readdir(dir)).filter((name) => name.startsWith(".decupa-aula.mp4.stale-"));
    expect(stales).toHaveLength(1);
    const stale = join(dir, stales[0] ?? "");
    expect(await readFile(join(stale, "transcript.json"), "utf8")).toBe(oldTranscript);
    expect(await readFile(join(stale, "corte.edl"), "utf8")).toBe(EXPORT_EDL);
    const oldSource = JSON.parse(await readFile(join(stale, "source.json"), "utf8")) as {
      size: number;
      mtimeMs: number;
    };
    const fresh = JSON.parse(await readFile(join(dir, ".decupa-aula.mp4", "source.json"), "utf8")) as {
      size: number;
      mtimeMs: number;
    };
    expect(fresh.size).toBe(oldSource.size);
    expect(fresh.mtimeMs).not.toBe(oldSource.mtimeMs);
  });

  it("aula.mov e aula.mp4 não dividem a pasta de trabalho", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-ext-"));
    const mov = join(dir, "aula.mov");
    const mp4 = join(dir, "aula.mp4");
    await writeFile(mov, "mov");
    await writeFile(mp4, "mp4-bytes");
    const movApp = await startApp({ input: mov, port: 0, autoStart: false });
    const mp4App = await startApp({ input: mp4, port: 0, autoStart: false });
    try {
      const names = (await readdir(dir)).filter((name) => name.startsWith(".decupa-")).sort();
      expect(names).toEqual([".decupa-aula.mov", ".decupa-aula.mp4"]);
      const movSource = JSON.parse(await readFile(join(dir, ".decupa-aula.mov", "source.json"), "utf8")) as {
        path: string;
      };
      const mp4Source = JSON.parse(await readFile(join(dir, ".decupa-aula.mp4", "source.json"), "utf8")) as {
        path: string;
      };
      expect(movSource.path).toBe(resolve(mov));
      expect(mp4Source.path).toBe(resolve(mp4));
    } finally {
      await movApp.close();
      await mp4App.close();
    }
  });

  it("pasta legada .decupa-aula não é reusada nem alterada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-legacy-"));
    const input = join(dir, "aula.mp4");
    await writeFile(input, "A");
    const legacy = join(dir, ".decupa-aula");
    const transcript = "{\"segments\":[{\"text\":\"legado\"}]}\n";
    const keep = "u001-u009\n";
    await mkdir(join(legacy, "out"), { recursive: true });
    await writeFile(join(legacy, "transcript.json"), transcript, "utf8");
    await writeFile(join(legacy, "keep.txt"), keep, "utf8");
    const calls: string[] = [];

    await runCleanup(input, calls);

    expect(calls).toHaveLength(1);
    expect(await readFile(join(legacy, "transcript.json"), "utf8")).toBe(transcript);
    expect(await readFile(join(legacy, "keep.txt"), "utf8")).toBe(keep);
    const names = await readdir(dir);
    expect(names).toContain(".decupa-aula");
    expect(names).toContain(".decupa-aula.mp4");
    expect(names.filter((name) => name.startsWith(".decupa-aula.stale-"))).toEqual([]);
  });

  it("fonte inalterada reusa a transcrição e não cria pasta stale", async () => {
    // Guarda: a fonte igual já era reusada antes da correção.
    const dir = await mkdtemp(join(tmpdir(), "decupa-same-"));
    const input = join(dir, "aula.mp4");
    await writeFile(input, "A");
    const calls: string[] = [];
    await runCleanup(input, calls);
    await runCleanup(input, calls);
    expect(calls).toHaveLength(1);
    expect((await readdir(dir)).filter((name) => name.includes(".stale-"))).toEqual([]);
  });

  it("fonte inexistente não move nem apaga a pasta já populada", async () => {
    // Guarda: input ausente já deixava o workDir override intocado.
    const dir = await mkdtemp(join(tmpdir(), "decupa-missing-"));
    const work = join(dir, "w");
    await mkdir(work);
    await writeFile(join(work, "keep.txt"), "u001\n", "utf8");
    await writeFile(join(work, "corte.edl"), EXPORT_EDL, "utf8");
    const app = await startApp({
      input: join(dir, "missing.mp4"),
      port: 0,
      autoStart: false,
      workDir: work,
    });
    await app.close();
    expect(await readFile(join(work, "keep.txt"), "utf8")).toBe("u001\n");
    expect(await readFile(join(work, "corte.edl"), "utf8")).toBe(EXPORT_EDL);
    expect((await readdir(dir)).filter((name) => name.includes(".stale-"))).toEqual([]);
    await expect(readFile(join(work, "source.json"), "utf8")).rejects.toThrow();
  });
});
