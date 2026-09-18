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
  cancel: (taskId: string) => void;
  close: () => Promise<void>;
};

type Waiter = {
  resolve: (value: SidecarResult) => void;
  reject: (error: Error) => void;
};

/**
 * Um processo `worker.py --serve` para vários arquivos. `transcribe.py`
 * continua sendo o CLI de processo único.
 */
export function createResidentSpeechClient(opts: {
  spawn?: SpeechSpawner;
  speechDir?: string;
  onStderr?: (chunk: string) => void;
} = {}): ResidentSpeechClient {
  const spawnFn = opts.spawn ?? spawn;
  const speechDir = opts.speechDir ?? SPEECH_DIR;
  const onStderr = opts.onStderr ?? ((chunk: string) => {
    process.stderr.write(chunk);
  });
  let child: ChildProcess | null = null;
  let buffer = "";
  let chain: Promise<unknown> = Promise.resolve();
  const waiters = new Map<string, Waiter>();

  const dispatch = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const rec = parsed as { taskId?: string; error?: string };
    if (typeof rec.taskId !== "string" || rec.taskId.length === 0) return;
    const waiter = waiters.get(rec.taskId);
    if (!waiter) return;
    waiters.delete(rec.taskId);
    if (typeof rec.error === "string" && rec.error.length > 0) {
      waiter.reject(new Error(rec.error));
      return;
    }
    try {
      waiter.resolve(parseSidecarOutput(line));
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const ensure = (): ChildProcess => {
    if (child) return child;
    const proc = spawnFn("uv", ["run", "python", "worker.py", "--serve"], { cwd: speechDir });
    child = proc;
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      if (child !== proc) return;
      onStderr(String(chunk));
    });
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      if (child !== proc) return;
      buffer += String(chunk);
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) dispatch(line);
      }
    });
    proc.on("error", (error: Error) => {
      if (child !== proc) return;
      child = null;
      buffer = "";
      for (const [id, waiter] of waiters) {
        waiters.delete(id);
        waiter.reject(error);
      }
    });
    proc.on("exit", () => {
      if (child !== proc) return;
      child = null;
      buffer = "";
      for (const [id, waiter] of waiters) {
        waiters.delete(id);
        waiter.reject(new Error("worker de fala encerrou"));
      }
    });
    return proc;
  };

  const cancel = (taskId: string): void => {
    const proc = ensure();
    proc.stdin?.write(`${JSON.stringify({
      cmd: "cancel",
      args: { task_id: taskId },
    })}\n`);
  };

  const transcribe = (req: SpeechWorkerRequest): Promise<SidecarResult> => {
    const run = (): Promise<SidecarResult> => new Promise((resolvePromise, reject) => {
      if (req.signal?.aborted) {
        reject(new Error(`tarefa cancelada: ${req.taskId}`));
        return;
      }
      const proc = ensure();
      if (!proc.stdout || !proc.stdin) {
        reject(new Error("worker de fala sem stdin/stdout"));
        return;
      }
      const onAbort = (): void => {
        cancel(req.taskId);
      };
      const settle = {
        resolve: (value: SidecarResult) => {
          req.signal?.removeEventListener("abort", onAbort);
          resolvePromise(value);
        },
        reject: (error: Error) => {
          req.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      waiters.set(req.taskId, settle);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      proc.stdin.write(`${JSON.stringify({
        cmd: "transcribe",
        args: {
          task_id: req.taskId,
          wav: req.wav,
          language: req.language,
          model: req.model ?? "small",
          ...(req.computeType ? { compute_type: req.computeType } : {}),
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

  return { transcribe, cancel, close };
}
