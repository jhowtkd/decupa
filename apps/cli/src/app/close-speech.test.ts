import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";

const closeSpy = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@decupa/transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@decupa/transcript")>()),
  createResidentSpeechClient: () => ({
    transcribe: async () => ({ language: "pt", words: [], unaligned: [] }),
    cancel: () => {},
    close: closeSpy,
  }),
}));

const { startApp } = await import("./server.ts");
const { createServerSpeechRuntime } = await import("./speech-runtime.ts");

const dirs: string[] = [];
afterEach(async () => {
  closeSpy.mockClear();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "close-speech-"));
  dirs.push(dir);
  return dir;
}

async function activeSpeech(dir: string) {
  const env = {};
  const runtime = createServerSpeechRuntime({
    executorInjected: false, env,
    syncExecutor: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  });
  await runtime.attach(dir).speech!.worker({ taskId: "close-speech", wav: join(dir, "audio.wav"), language: "pt" });
  return { env, runtime };
}

// O cliente agora é lazy: sem uma transcrição, não há worker para fechar.
describe("close() não sobe o worker de fala sem transcrição", () => {
  it("montagem", async () => {
    const app = await startApp({ projectDir: await tmp(), port: 0, env: {} });
    const closing = app.close();
    expect(closeSpy).toHaveBeenCalledTimes(0);
    await closing;
  });

  it("limpeza", async () => {
    const dir = await tmp();
    const input = join(dir, "clip.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), input);
    const app = await startApp({ input, port: 0, autoStart: false, workDir: join(dir, "work"), env: {} });
    const closing = app.close();
    expect(closeSpy).toHaveBeenCalledTimes(0);
    await closing;
  });
});

// O handler de `exit` só roda código síncrono: se o closeSpeech vier depois de
// um `await`, o worker residente nunca é fechado nesse caminho. A transcrição
// abaixo ativa o cliente real do runtime compartilhado antes de fechar o app.
describe("close() fecha o worker residente antes do primeiro await", () => {
  it("montagem legada", async () => {
    const dir = await tmp();
    const { env, runtime } = await activeSpeech(dir);
    const app = await startApp({ projectDir: dir, port: 0, env, speechRuntime: runtime });
    const closing = app.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await closing;
  });

  it("limpeza legada", async () => {
    const dir = await tmp();
    const input = join(dir, "clip.mp4");
    const workDir = join(dir, "work");
    await copyFile(join(FIXTURES, "clip.mp4"), input);
    const { env, runtime } = await activeSpeech(workDir);
    const app = await startApp({ input, port: 0, autoStart: false, workDir, env, speechRuntime: runtime });
    const closing = app.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await closing;
  });

  it("modo Raiz", async () => {
    const root = await tmp();
    const dir = join(root, "montagem");
    const { env, runtime } = await activeSpeech(dir);
    const app = await startApp({ projectsRoot: root, projectDir: dir, port: 0, env, speechRuntime: runtime });
    const closing = app.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await closing;
  });
});

it("killChildren() fecha o worker de fala de forma síncrona", async () => {
  const dir = await tmp();
  const { env, runtime } = await activeSpeech(dir);
  const app = await startApp({ projectDir: dir, port: 0, env, speechRuntime: runtime });
  app.killChildren();
  // O handler de `exit` não pode aguardar a Promise de close().
  expect(closeSpy).toHaveBeenCalledTimes(1);
  await app.close();
});
