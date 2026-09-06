import { randomUUID } from "node:crypto";
import type { Review } from "./review.ts";

export type Stage =
  | "queued" | "transcribing" | "indexing" | "visual" | "planning"
  | "ready" | "error" | "cancelled";

const TERMINAL: ReadonlySet<Stage> = new Set(["error", "cancelled"]);

export interface Job {
  id: string;
  videoPath: string;
  workDir: string;
  stage: Stage;
  error?: string;
  warning?: string;
  progress?: string;
  keepList?: string;
  review?: Review;
}

/**
 * Um job por vez, em memória, sem banco. É app local de um usuário só;
 * persistência e fila seriam complexidade sem cliente. Reiniciar perde o job
 * em andamento, o que é aceitável porque a transcrição fica em cache no
 * diretório de trabalho e re-rodar sai barato.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  create(opts: { videoPath: string; workDir: string }): Job {
    const job: Job = { id: randomUUID(), stage: "queued", ...opts };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Estado terminal não volta atrás: etapa que termina depois de um erro
   *  não pode apagar o erro da tela. */
  private mutate(id: string, patch: Partial<Job>, force = false): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (TERMINAL.has(job.stage) && !force) return;
    this.jobs.set(id, { ...job, ...patch });
  }

  setStage(id: string, stage: Stage): void {
    // Progresso pertence ao estágio que o produziu: carregá-lo adiante mostra
    // a linha de uma etapa que já acabou como se fosse a atual.
    this.mutate(id, { stage, progress: undefined });
  }

  setProgress(id: string, progress: string): void {
    this.mutate(id, { progress: progress.slice(0, 120) });
  }

  setReview(id: string, review: Review, keepList: string): void {
    this.mutate(id, { review, keepList, stage: "ready" });
  }

  setKeepList(id: string, keepList: string): void {
    this.mutate(id, { keepList });
  }

  setWarning(id: string, warning: string): void {
    this.mutate(id, { warning });
  }

  fail(id: string, error: string): void {
    // Cancelar vence: matar o processo faz a etapa falhar, e esse erro não
    // pode virar "erro: SIGTERM" na tela de quem pediu para parar.
    if (this.jobs.get(id)?.stage === "cancelled") return;
    this.mutate(id, { stage: "error", error }, true);
  }

  cancel(id: string): void {
    this.mutate(id, { stage: "cancelled" }, true);
  }
}
