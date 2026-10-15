import { homedir } from "node:os";
import { join } from "node:path";
import { createFileCoordinator, type FileCoordinator } from "@decupa/coordinator";

export type HeavyWorkOptions = {
  coordinatorDir?: string;
  configDir?: string;
  env: Record<string, string | undefined>;
};

/** DECUPA_JOB_CONCURRENCY controla somente o trabalho pesado compartilhado. */
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
 * a home padrão; em produção a CLI passa a home do usuário.
 */
export function createHeavyCoordinator(opts: HeavyWorkOptions): FileCoordinator {
  const dir = opts.coordinatorDir
    ?? join(opts.configDir ?? homedir(), ".decupa", "coordinator");
  return createFileCoordinator(dir, { limit: jobConcurrency(opts.env) });
}

export function runHeavy<T>(
  coordinator: FileCoordinator | undefined,
  opts: {
    stage: string;
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
    signal: opts.signal,
  }, () => {
      opts.onStarted?.();
      return opts.build();
  });
}
