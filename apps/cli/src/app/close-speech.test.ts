import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";

const closeSpy = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@decupa/transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@decupa/transcript")>()),
  createResidentSpeechClient: () => ({
    transcribe: async () => { throw new Error("não devia transcrever"); },
    cancel: () => {},
    close: closeSpy,
  }),
}));

const { startApp } = await import("./server.ts");

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
