import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
const closeClient = vi.hoisted(() => vi.fn(async () => undefined));
const transcribe = vi.hoisted(() => vi.fn(async () => ({ language: "pt", words: [], unaligned: [] })));

vi.mock("@decupa/transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@decupa/transcript")>()),
  createResidentSpeechClient: (opts?: unknown) => {
    createClient(opts);
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


it("killChildren encerra o runtime: transcrição depois disso é recusada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "speech-runtime-kill-"));
  dirs.push(dir);
  const runtime = createServerSpeechRuntime({
    executorInjected: false,
    env: {},
    syncExecutor: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  });
  const speech = runtime.attach(join(dir, "alpha")).speech!;
  const request = { taskId: "t", wav: "audio.wav", language: "pt" };
  await speech.worker(request);
  expect(createClient).toHaveBeenCalledTimes(1);

  runtime.killChildren();
  expect(closeClient).toHaveBeenCalledTimes(1);
  // O `exit` não espera; o que vier depois não pode reabrir nem usar o cliente morto.
  await expect(speech.worker(request)).rejects.toThrow(/encerrou/);
  expect(createClient).toHaveBeenCalledTimes(1);
  await runtime.close();
});

it("DECUPA_SPEECH_DEVICE aceita só cpu ou cuda e chega ao worker residente", async () => {
  expect(() => createServerSpeechRuntime({
    executorInjected: false,
    env: { DECUPA_SPEECH_DEVICE: "gpu" },
  })).toThrow(/cpu ou cuda/);

  const dir = await mkdtemp(join(tmpdir(), "speech-runtime-device-"));
  dirs.push(dir);
  const syncExecutor = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const request = { taskId: "t", wav: "audio.wav", language: "pt" };

  const padrao = createServerSpeechRuntime({ executorInjected: false, env: {}, syncExecutor });
  await padrao.attach(join(dir, "alpha")).speech!.worker(request);
  expect(createClient).toHaveBeenLastCalledWith({ device: "cpu" });
  await padrao.close();

  const gpu = createServerSpeechRuntime({
    executorInjected: false,
    env: { DECUPA_SPEECH_DEVICE: "cuda" },
    syncExecutor,
  });
  await gpu.attach(join(dir, "beta")).speech!.worker(request);
  expect(createClient).toHaveBeenLastCalledWith({ device: "cuda" });
  await gpu.close();
});
