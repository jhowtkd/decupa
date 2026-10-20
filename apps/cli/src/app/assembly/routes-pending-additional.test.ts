import { copyFile, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SpeechWorkerInterruptedError, type SpeechWorkerRequest } from "@decupa/transcript";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject, loadProject } from "./store.ts";
import type { Project, Source } from "./types.ts";

vi.mock("@decupa/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@decupa/media")>();
  return { ...actual, extractAudio: async ({ input }: { input: string }) => {
    const { access } = await import("node:fs/promises");
    await access(input);
  } };
});

let stop: (() => Promise<void>) | null = null;
const tempDirs: string[] = [];
afterEach(async () => {
  await stop?.();
  stop = null;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 1, duration: 1,
    text: "olá", has_terminal_punct: true, is_question: false,
    word_count: 1, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

function indexingExec(): Executor {
  return {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

async function seededApp(options: { speech?: Parameters<typeof startApp>[0]["speech"] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "assembly-pending-additional-"));
  tempDirs.push(dir);
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const project = blankProject("pending-additional");
  const source = { ...fixtureAssembly().sources[0]!, path: clip, hasVideo: false } as Source;
  project.assembly.sources = [source];
  project.corrections = [{
    id: "corr-pending", sourceId: source.id, start: 0, end: 0.5,
    text: "fala nova", status: "pending", words: [],
  }];
  await createProject(dir, project as Project);
  const app = await startApp({
    projectDir: dir,
    port: 0,
    executor: indexingExec(),
    speech: options.speech,
  });
  stop = app.close;
  return { base: `http://127.0.0.1:${app.port}`, dir, source };
}

const aligned = {
  language: "pt",
  words: [
    { text: "fala", startMs: 100, endMs: 250, confidence: 0.9, sentenceIndex: 0 },
    { text: "nova", startMs: 260, endMs: 430, confidence: 0.9, sentenceIndex: 0 },
  ],
  unaligned: [],
};

it.each(["worker de fala encerrou", "alinhamento cancelado"]) (
  "mantém correção pending após encerramento/cancelamento e GET seguinte relança (%s)",
  async (reason) => {
    let attempts = 0;
    const worker = vi.fn(async (_req: SpeechWorkerRequest) => {
      attempts += 1;
      if (attempts === 1) throw new SpeechWorkerInterruptedError(reason);
      return aligned;
    });
    const { base, dir } = await seededApp({
      speech: { worker, extract: async () => {}, detectSilence: async () => [] },
    });

    await fetch(`${base}/project`);
    await vi.waitFor(async () => {
      expect(worker).toHaveBeenCalledTimes(1);
      expect((await loadProject(dir)).corrections[0]?.status).toBe("pending");
    });
    await fetch(`${base}/project`);
    await vi.waitFor(async () => {
      expect((await loadProject(dir)).corrections[0]?.status).toBe("aligned");
    });
    expect(worker).toHaveBeenCalledTimes(2);
  },
);

it("mantém correção pending sem worker e tenta novamente no GET seguinte", async () => {
  const { base, dir } = await seededApp();
  await fetch(`${base}/project`);
  await vi.waitFor(async () => {
    expect((await loadProject(dir)).corrections[0]?.status).toBe("pending");
  });
  expect((await loadProject(dir)).corrections[0]?.error).toBeUndefined();

  // Simula novo processo após o worker ficar disponível: o pending persistido
  // deve ser agendado pelo GET e concluído sem recriar a correção.
  await stop?.();
  let attempts = 0;
  const worker = vi.fn(async () => { attempts += 1; return aligned; });
  const restarted = await startApp({
    projectDir: dir,
    port: 0,
    executor: indexingExec(),
    speech: { worker, extract: async () => {}, detectSilence: async () => [] },
  });
  stop = restarted.close;
  await fetch(`http://127.0.0.1:${restarted.port}/project`);
  await vi.waitFor(async () => {
    expect((await loadProject(dir)).corrections[0]?.status).toBe("aligned");
  });
  expect(worker).toHaveBeenCalledTimes(1);
});

it("mantém erro de conteúdo quando a cobertura do alinhamento é inválida", async () => {
  const { base, dir } = await seededApp({
    speech: {
      worker: async () => ({ ...aligned, words: [], unaligned: ["fala nova"] }),
      extract: async () => {}, detectSilence: async () => [],
    },
  });
  await fetch(`${base}/project`);
  await vi.waitFor(async () => {
    expect((await loadProject(dir)).corrections[0]?.status).toBe("error");
  });
  expect((await loadProject(dir)).corrections[0]?.error).toMatch(/cobertura|correspondência/i);
});

it("mantém erro de conteúdo quando a cobertura está completa mas os tempos são inválidos", async () => {
  const { base, dir } = await seededApp({
    speech: {
      worker: async () => ({
        ...aligned,
        words: [
          { text: "fala", startMs: 100, endMs: 100, confidence: 0.9, sentenceIndex: 0 },
          { text: "nova", startMs: 260, endMs: 430, confidence: 0.9, sentenceIndex: 0 },
        ],
      }),
      extract: async () => {}, detectSilence: async () => [],
    },
  });
  await fetch(`${base}/project`);
  await vi.waitFor(async () => {
    expect((await loadProject(dir)).corrections[0]?.status).toBe("error");
  });
  expect((await loadProject(dir)).corrections[0]?.error).toContain("tempo inválido");
});

it("mantém erro quando o arquivo da fonte de mídia desapareceu", async () => {
  const worker = vi.fn(async () => aligned);
  const { base, dir, source } = await seededApp({
    speech: { worker, extract: async () => {}, detectSilence: async () => [] },
  });
  await unlink(source.path);
  await fetch(`${base}/project`);
  await vi.waitFor(async () => {
    expect((await loadProject(dir)).corrections[0]?.status).toBe("error");
  });
  expect((await loadProject(dir)).corrections[0]?.error).toMatch(/ENOENT|no such file|não existe/i);
  expect(worker).not.toHaveBeenCalled();
});
