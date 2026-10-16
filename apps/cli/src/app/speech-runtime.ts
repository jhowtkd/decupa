import { dirname, join } from "node:path";
import { createFileCoordinator } from "@decupa/coordinator";
import { createResidentSpeechClient, type ResidentSpeechClient } from "@decupa/transcript";
import type { IngestSpeech, Executor } from "./pipeline.ts";
import { assertSidecarSynced, SPEECH_SCRIPT, SpawnExecutor } from "./pipeline.ts";

type SpeechRuntimeOptions = {
  speech?: IngestSpeech;
  executorInjected: boolean;
  /** Executor apenas para conferir o ambiente do sidecar; não possui filhos do worker. */
  syncExecutor?: Executor;
  env: Record<string, string | undefined>;
  now?: () => number;
};

export type ServerSpeechRuntime = {
  attach(dir: string): { speech?: IngestSpeech };
  sweep(): Promise<void>;
  close(): Promise<void>;
  killChildren(): void;
};

function idleMinutes(env: Record<string, string | undefined>): number {
  const raw = env.DECUPA_SPEECH_IDLE_MINUTES;
  if (raw === undefined || raw.trim() === "") return 15;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("DECUPA_SPEECH_IDLE_MINUTES precisa ser um inteiro >= 0");
  }
  return value;
}

/**
 * CPU é o padrão do worker. `cuda` só vem de pedido explícito do operador
 * (o perfil de GPU define DECUPA_SPEECH_DEVICE=cuda); sem placa, o worker cai
 * para CPU e avisa no log.
 */
function speechDevice(env: Record<string, string | undefined>): "cpu" | "cuda" {
  const raw = env.DECUPA_SPEECH_DEVICE?.trim() ?? "";
  if (raw === "") return "cpu";
  if (raw === "cpu" || raw === "cuda") return raw;
  throw new Error("DECUPA_SPEECH_DEVICE precisa ser cpu ou cuda");
}

/**
 * O processo Python é do servidor, não do Projeto. O coordinator que guarda
 * a transcrição continua sendo criado por Projeto, porque esse cache não pode
 * fazer uma Mídia de uma pasta vencer a transcrição de outra.
 */
export function createServerSpeechRuntime(opts: SpeechRuntimeOptions): ServerSpeechRuntime {
  const now = opts.now ?? Date.now;
  const idleMs = idleMinutes(opts.env) * 60_000;
  const device = speechDevice(opts.env);
  const executor = new SpawnExecutor();
  const syncExecutor = opts.syncExecutor ?? executor;
  const speechEnv = Object.fromEntries(
    Object.entries(opts.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const createExecutor: Executor = {
    run: (call) => syncExecutor.run({ ...call, env: { ...speechEnv, ...call.env } }),
  };
  let client: ResidentSpeechClient | undefined;
  let synced: Promise<void> | undefined;
  let lastUsed: number | undefined;
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMs === 0 || !client || closed) return;
    idleTimer = setTimeout(() => {
      void sweep().finally(() => {
        if (client) armIdleTimer();
      });
    }, idleMs);
    idleTimer.unref?.();
  };

  const ensureSynced = (): Promise<void> => {
    synced ??= assertSidecarSynced(createExecutor, dirname(SPEECH_SCRIPT), "fala")
      .catch((error: unknown) => {
        synced = undefined;
        throw error;
      });
    return synced;
  };

  const speech: IngestSpeech | undefined = opts.speech
    ? undefined
    : opts.executorInjected
      ? undefined
      : {
          worker: async (req) => {
            if (closed) throw new Error("worker de fala encerrou");
            client ??= createResidentSpeechClient({ device });
            const activeClient = client;
            lastUsed = now();
            inFlight += 1;
            armIdleTimer();
            try {
              await ensureSynced();
              return await activeClient.transcribe(req);
            } finally {
              inFlight -= 1;
              lastUsed = now();
              armIdleTimer();
            }
          },
        };

  async function sweep(): Promise<void> {
    if (!client || idleMs === 0 || inFlight > 0 || lastUsed === undefined) return;
    if (now() - lastUsed < idleMs) return;
    const old = client;
    client = undefined;
    synced = undefined;
    lastUsed = undefined;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    await old.close();
  }

  return {
    attach(dir: string): { speech?: IngestSpeech } {
      if (opts.speech) {
        return {
          speech: opts.speech.coordinator
            ? opts.speech
            : { ...opts.speech, coordinator: createFileCoordinator(join(dir, ".decupa", "coordinator")) },
        };
      }
      if (!speech) return {};
      return {
        speech: { ...speech, coordinator: createFileCoordinator(join(dir, ".decupa", "coordinator")) },
      };
    },
    sweep,
    close: async (): Promise<void> => {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      if (closing) return closing;
      const childrenClosed = executor.terminateAll();
      const old = client;
      client = undefined;
      if (!old) {
        await childrenClosed;
        return;
      }
      closing = Promise.all([old.close(), childrenClosed]).then(() => undefined);
      await closing;
    },
    killChildren: (): void => {
      // Só roda no `exit`, mas deixa o runtime coerente: nenhuma transcrição
      // posterior tenta usar o cliente cujo processo acabou de ser morto.
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      executor.killNow();
      const old = client;
      client = undefined;
      synced = undefined;
      void old?.close();
    },
  };
}

