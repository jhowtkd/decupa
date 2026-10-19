import { homedir } from "node:os";
import { join } from "node:path";
import { createFileCoordinator, type FileCoordinator, type TaskPriority } from "@decupa/coordinator";

export type HeavyWorkOptions = {
  coordinatorDir?: string;
  configDir?: string;
  env: Record<string, string | undefined>;
};

/** DECUPA_JOB_CONCURRENCY controla o trabalho local pesado; rede usa seu próprio pool. */
export function jobConcurrency(env: Record<string, string | undefined>): number {
  const raw = env.DECUPA_JOB_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("DECUPA_JOB_CONCURRENCY precisa ser um inteiro >= 1");
  }
  return value;
}

/**
 * O coordinator fica fora do Projeto para que CLI e MCP locais compartilhem
 * os slots. `configDir` existe para os testes e para instalações que não usam
 * a home padrão; em produção a CLI passa a home do usuário. `queue` não pode
 * coincidir com o cache de transcrição de um Projeto na própria home.
 */
export function createHeavyCoordinator(opts: HeavyWorkOptions): FileCoordinator {
  const dir = opts.coordinatorDir
    ?? join(opts.configDir ?? homedir(), ".decupa", "queue");
  return createFileCoordinator(dir, { limit: jobConcurrency(opts.env) });
}

export function runHeavy<T>(
  coordinator: FileCoordinator | undefined,
  opts: {
    stage: string;
    priority?: TaskPriority;
    signal?: AbortSignal;
    onQueued?: () => void;
    onStarted?: () => void;
    build: () => Promise<T> | T;
  },
): Promise<T> {
  if (!coordinator) {
    opts.onStarted?.();
    return Promise.resolve().then(opts.build);
  }
  opts.onQueued?.();
  return coordinator.withSlot({
    stage: opts.stage,
    // Prévias pedidas no editor precedem análise em lote; o chamador pode
    // declarar batch para renders de fundo ou interactive para análise.
    priority: opts.priority ?? (opts.stage === "rendering" ? "interactive" : "batch"),
    signal: opts.signal,
  }, () => {
      opts.onStarted?.();
      return opts.build();
  });
}
