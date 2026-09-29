import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidecarOutput, type SidecarResult, type SpeechWorkerRequest } from "./transcribe.ts";

const SPEECH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../services/speech",
);

/** Prefixo das linhas de progresso que o `worker.py` escreve no stderr. */
export const PROGRESS_PREFIX = "DECUPA_PROGRESS ";

/** Sem nenhuma linha de progresso por este tempo, o worker é dado como travado. */
export const DEFAULT_WATCHDOG_MS = 10 * 60_000;

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
  /** Encerra o processo atual; o próximo pedido sobe um worker novo. */
  restart: () => void;
  close: () => Promise<void>;
};

type Waiter = {
  resolve: (value: SidecarResult) => void;
  reject: (error: Error) => void;
  /** Linha de progresso desta tarefa: rearma o watchdog e vai para a tela. */
  progress: (line: string) => void;
};

/** `{"taskId","stage","percent"}` → "transcrevendo 42%". Lixo vira null. */
function parseProgress(raw: string): { taskId: string; line: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = parsed as { taskId?: unknown; stage?: unknown; percent?: unknown };
  if (typeof rec.taskId !== "string" || typeof rec.stage !== "string") return null;
  const percent = typeof rec.percent === "number" && Number.isFinite(rec.percent)
    ? ` ${Math.round(rec.percent)}%`
    : "";
  return { taskId: rec.taskId, line: `${rec.stage}${percent}` };
}

/**
 * Um processo `worker.py --serve` para vários arquivos. `transcribe.py`
 * continua sendo o CLI de processo único.
 *
 * Os pedidos vão um por vez, então cancelar ou vencer o watchdog encerra o
 * processo inteiro: o WhisperX só conferia o cancelamento entre etapas, e
 * uma etapa leva minutos. O próximo pedido sobe um worker novo.
 */
export function createResidentSpeechClient(opts: {
  spawn?: SpeechSpawner;
  speechDir?: string;
  onStderr?: (chunk: string) => void;
  /** Tempo máximo sem linha de progresso da tarefa em andamento. */
  watchdogMs?: number;
} = {}): ResidentSpeechClient {
  const spawnFn = opts.spawn ?? spawn;
  const speechDir = opts.speechDir ?? SPEECH_DIR;
  const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const onStderr = opts.onStderr ?? ((chunk: string) => {
    process.stderr.write(chunk);
  });
  let child: ChildProcess | null = null;
  let buffer = "";
  let errBuffer = "";
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

  const stderrLine = (line: string): void => {
    if (line.startsWith(PROGRESS_PREFIX)) {
      const progress = parseProgress(line.slice(PROGRESS_PREFIX.length));
      if (progress) waiters.get(progress.taskId)?.progress(progress.line);
      return;
    }
    onStderr(`${line}\n`);
  };

  /** Mata o processo atual e rejeita quem esperava por ele. */
  const stop = (error: Error): void => {
    const proc = child;
    child = null;
    buffer = "";
    errBuffer = "";
    for (const [id, waiter] of waiters) {
      waiters.delete(id);
      waiter.reject(error);
    }
    if (!proc) return;
    proc.stdin?.end();
    proc.kill();
  };

  const ensure = (): ChildProcess => {
    if (child) return child;
    const proc = spawnFn("uv", ["run", "--no-sync", "python", "worker.py", "--serve"], { cwd: speechDir });
    child = proc;
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      if (child !== proc) return;
      // Buffer por linha: a linha de progresso pode chegar partida em dois
      // chunks, e metade dela não pode vazar para o terminal nem se perder.
      const parts = (errBuffer + String(chunk)).split(/\r?\n|\r/);
      errBuffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line.trim()) stderrLine(line);
      }
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
      errBuffer = "";
      for (const [id, waiter] of waiters) {
        waiters.delete(id);
        waiter.reject(error);
      }
    });
    proc.on("exit", () => {
      if (child !== proc) return;
      child = null;
      buffer = "";
      errBuffer = "";
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const minutes = Math.max(1, Math.round(watchdogMs / 60_000));
          stop(new Error(
            `o worker de fala ficou ${minutes} min sem dar sinal de progresso e foi encerrado. ` +
            "Tente de novo; se voltar a travar, confira o áudio do vídeo e a instalação em services/speech.",
          ));
        }, watchdogMs);
      };
      const onAbort = (): void => {
        // Fechar e subir de novo: o cancelamento do worker só vale entre
        // etapas, e a transcrição de um vídeo longo é uma etapa só.
        stop(new Error(`tarefa cancelada: ${req.taskId}`));
      };
      const done = (): void => {
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      };
      waiters.set(req.taskId, {
        resolve: (value) => { done(); resolvePromise(value); },
        reject: (error) => { done(); reject(error); },
        progress: (line) => { arm(); req.onProgress?.(line); },
      });
      req.signal?.addEventListener("abort", onAbort, { once: true });
      arm();
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

  const restart = (): void => {
    stop(new Error("worker de fala reiniciado"));
  };

  const close = async (): Promise<void> => {
    stop(new Error("worker de fala encerrou"));
  };

  return { transcribe, cancel, restart, close };
}
