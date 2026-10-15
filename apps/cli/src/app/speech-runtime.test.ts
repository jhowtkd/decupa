import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
const closeClient = vi.hoisted(() => vi.fn(async () => undefined));
const transcribe = vi.hoisted(() => vi.fn(async () => ({ language: "pt", words: [], unaligned: [] })));

vi.mock("@decupa/transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@decupa/transcript")>()),
  createResidentSpeechClient: () => {
    createClient();
    return { transcribe, cancel: () => {}, restart: () => {}, close: closeClient };
  },
}));

const { createServerSpeechRuntime } = await import("./speech-runtime.ts");

const dirs: string[] = [];
afterEach(async () => {
  createClient.mockClear();
  closeClient.mockClear();
  transcribe.mockClear();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")("compartilha um worker e o recria depois do ócio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "speech-runtime-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const uv = join(bin, "uv");
  await writeFile(uv, `#!${process.execPath}\nprocess.exit(0);\n`, "utf8");
  await chmod(uv, 0o755);

  let clock = 0;
  const runtime = createServerSpeechRuntime({
    executorInjected: false,
    env: { PATH: bin },
    now: () => clock,
  });
  const alpha = runtime.attach(join(dir, "alpha")).speech!;
  const beta = runtime.attach(join(dir, "beta")).speech!;
  const request = (taskId: string) => ({ taskId, wav: "audio.wav", language: "pt" });

  await alpha.worker(request("a"));
  await beta.worker(request("b"));
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(transcribe).toHaveBeenCalledTimes(2);

  clock = 15 * 60_000;
  await runtime.sweep();
  expect(closeClient).toHaveBeenCalledTimes(1);

  await alpha.worker(request("c"));
  expect(createClient).toHaveBeenCalledTimes(2);
  await runtime.close();
  expect(closeClient).toHaveBeenCalledTimes(2);

  const never = createServerSpeechRuntime({
    executorInjected: false,
    env: { PATH: bin, DECUPA_SPEECH_IDLE_MINUTES: "0" },
    now: () => clock,
  });
  await never.attach(join(dir, "alpha")).speech!.worker(request("d"));
  clock += 60 * 60_000;
  await never.sweep();
  expect(closeClient).toHaveBeenCalledTimes(2);
  await never.close();
  expect(closeClient).toHaveBeenCalledTimes(3);
});

