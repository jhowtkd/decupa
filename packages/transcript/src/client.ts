import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidecarOutput, type SidecarResult, type SpeechWorkerRequest } from "./transcribe.ts";

const SPEECH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../services/speech",
);

export type SpeechSpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type SpeechSpawner = (
  command: string,
  args: string[],
  options?: SpeechSpawnOptions,
) => ChildProcess;

export type ResidentSpeechClient = {
  transcribe: (req: SpeechWorkerRequest) => Promise<SidecarResult>;
  close: () => Promise<void>;
};

/**
 * Um processo `worker.py --serve` para vários arquivos. `transcribe.py`
 * continua sendo o CLI de processo único.
 */
export function createResidentSpeechClient(opts: {
  spawn?: SpeechSpawner;
  speechDir?: string;
} = {}): ResidentSpeechClient {
  const spawnFn = opts.spawn ?? spawn;
  const speechDir = opts.speechDir ?? SPEECH_DIR;
  let child: ChildProcess | null = null;
  let buffer = "";
  let chain: Promise<unknown> = Promise.resolve();

  const ensure = (): ChildProcess => {
    if (child) return child;
    child = spawnFn("uv", ["run", "python", "worker.py", "--serve"], { cwd: speechDir });
    child.stderr?.on("data", () => undefined);
    child.on("exit", () => {
      child = null;
    });
    return child;
  };

  const transcribe = (req: SpeechWorkerRequest): Promise<SidecarResult> => {
    const run = (): Promise<SidecarResult> => new Promise((resolvePromise, reject) => {
      const proc = ensure();
      const onData = (chunk: Buffer | string): void => {
        buffer += String(chunk);
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        proc.stdout?.off("data", onData);
        try {
          resolvePromise(parseSidecarOutput(line));
        } catch (error) {
          reject(error);
        }
      };
      if (!proc.stdout || !proc.stdin) {
        reject(new Error("worker de fala sem stdin/stdout"));
        return;
      }
      proc.stdout.on("data", onData);
      proc.on("error", reject);
      proc.stdin.write(`${JSON.stringify({
        args: {
          task_id: req.taskId,
          wav: req.wav,
          language: req.language,
          model: req.model ?? "small",
        },
      })}\n`);
    });
    const pending = chain.then(run, run);
    chain = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const close = async (): Promise<void> => {
    if (!child) return;
    const proc = child;
    child = null;
    proc.stdin?.end();
    proc.kill();
  };

  return { transcribe, close };
}
