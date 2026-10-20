import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { createFileCoordinator, type CoordinatorQueueEntry, type CoordinatorHolderEntry, type FileCoordinator } from "@decupa/coordinator";
import { activityView } from "./assembly/editor/progress.js";
import { prepareNeedsConfirm } from "./assembly/editor/prepare-confirm.js";
import { isPreparationActive } from "./assembly/preparation.ts";
import { recoverInterruptedPreparation } from "./assembly/preparation-recovery.ts";
import { loadProject, missingMedia } from "./assembly/store.ts";
import { stableCleanupJobId } from "./jobs.ts";
import { readKeepList, sourceMismatch } from "./session.ts";
import { deriveLifecycle, retentionMs, type ProjectLifecycle } from "./project-lifecycle.ts";

const QUEUE_STAGES: Record<string, string> = {
  speech: "Processar áudio", transcription: "Transcrever áudio", transcribing: "Transcrever áudio",
  indexing: "Indexar mídia", visual: "Analisar imagens", rendering: "Renderizar prévia",
  preparing: "Preparar montagem", planning: "Planejar limpeza",
  queued: "Aguardando na fila", ready: "Concluída", error: "Falha", cancelled: "Cancelada", idle: "Sem etapa em execução",
};

export type RuntimeActivity = {
  busy: boolean;
  cancellable?: boolean;
  alignmentActive?: boolean;
  operation?: { stage: string; sourceId?: string; progress?: string; error?: string } | null;
  startedAt?: number | null;
};
export type HubActivity = {
  text: string; busy: boolean; queuePosition: number | null;
  executing: boolean; queuedCount: number; queueUnavailable: boolean; notice: string;
  stage: string; media: string; elapsedMs: number | null;
  result: string; approval: string; error: string;
  lifecycle: ProjectLifecycle; retentionAt: number | null;
  revision: number | null;
  jobId?: string;
  exportKind?: "mp4";
  actions: { resume: boolean; cancel: boolean; export: boolean };
};
export type HubActivityOptions = {
  runtime?: (id: string) => Promise<RuntimeActivity | undefined>;
  queue?: CoordinatorQueueEntry[];
  holders?: CoordinatorHolderEntry[];
  queueUnavailable?: boolean;
  env?: Record<string, string | undefined>;
};

/** Falha de observação não deve apagar a lista de Projetos nem fingir fila vazia. */
export async function readCoordinatorActivity(coordinator?: Pick<FileCoordinator, "queue" | "holders">) {
  const [queue, holders] = await Promise.allSettled([
    coordinator?.queue?.() ?? Promise.resolve([]), coordinator?.holders?.() ?? Promise.resolve([]),
  ]);
  return {
    queue: queue.status === "fulfilled" ? queue.value : [],
    holders: holders.status === "fulfilled" ? holders.value : [],
    queueUnavailable: queue.status === "rejected" || holders.status === "rejected",
  };
}

export async function projectActivity(dir: string, id: string, kind: "assembly" | "cleanup", now: () => number, opts: HubActivityOptions): Promise<HubActivity> {
  const runtime = await opts.runtime?.(id);
  // Consultar ocupantes e esperas não reivindica slots nem inicia runtimes.
  const local = await readCoordinatorActivity(createFileCoordinator(join(dir, ".decupa", "coordinator"), { now }));
  const belongs = (entry: { projectId?: string }) => entry.projectId === resolve(dir) || entry.projectId === id;
  const waiters = [...(opts.queue ?? []).filter(belongs), ...local.queue];
  const holder = (opts.holders ?? []).find(belongs) ?? local.holders[0];
  const queued = waiters[0];
  const queuedCount = waiters.length;
  const queueUnavailable = Boolean(opts.queueUnavailable || local.queueUnavailable);
  const preparing = kind === "assembly" && isPreparationActive(dir);
  const runtimeExecuting = runtime?.busy && runtime.operation?.stage !== "queued"
    && (runtime.cancellable || runtime.alignmentActive);
  const executing = Boolean(holder || runtimeExecuting || preparing && runtime?.operation?.stage !== "queued");
  const busy = Boolean(runtime?.busy || preparing || holder || queued);
  const began = !executing && queued ? queued.at
    : runtime?.busy && runtime.cancellable ? runtime.startedAt : holder?.startedAt;
  const elapsedMs = began == null || !busy ? null : Math.max(0, now() - began);
  const queueStage = queued?.stage ? QUEUE_STAGES[queued.stage] ?? queued.stage : null;
  const heldStage = holder?.stage ? QUEUE_STAGES[holder.stage] ?? holder.stage : null;
  if (kind === "cleanup") {
    const source = JSON.parse(await readFile(join(dir, "source.json"), "utf8")) as { displayName?: string; path?: string };
    const plan = await readFile(join(dir, "out", "condense_plan.json"), "utf8").then(raw => {
      const parsed = JSON.parse(raw) as { clips?: { start: number; end: number }[] };
      if (!parsed || !Array.isArray(parsed.clips)) throw new Error("plano de limpeza ilegível");
      return parsed.clips;
    }, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const planReady = plan !== null && plan.length > 0 && plan.every(clip => clip && Number.isFinite(clip.start) && clip.start >= 0 && Number.isFinite(clip.end) && clip.end > clip.start);
    const sourceReady = typeof source.path === "string" && await sourceMismatch(dir, source.path, { refreshManifest: false }).then(reason => reason === null, () => false);
    const keep = await readKeepList(dir);
    const lifecycle = await deriveLifecycle(dir, undefined, { now, busy, env: opts.env });
    const stage = runtime?.operation?.stage;
    const execution = executing ? "Processando limpeza" : "Aguardando na fila";
    const result = (plan ? "Plano de limpeza salvo" : "Sem plano de limpeza salvo") + (keep ? " · seleção salva" : "");
    return { text: busy ? execution : plan ? "Plano de limpeza pronto" : "Limpeza aguardando preparação",
      busy, executing, queuedCount, queueUnavailable, notice: queueUnavailable ? "Fila indisponível. Tente atualizar novamente." : "",
      queuePosition: queued?.position ?? null, stage: heldStage ?? queueStage ?? (stage ? QUEUE_STAGES[stage] ?? stage : "Sem etapa em execução"),
      media: source.path ? basename(source.path) : source.displayName || id, elapsedMs: busy ? elapsedMs : null, result,
      approval: "Não se aplica à Limpeza", error: runtime?.operation?.error ?? "", lifecycle, retentionAt: null, revision: null, jobId: stableCleanupJobId(dir), exportKind: "mp4",
      actions: { resume: false, cancel: Boolean(runtime?.busy && runtime.cancellable), export: planReady && sourceReady && !busy && !queueUnavailable } };
  }
  const project = await recoverInterruptedPreparation(dir, await loadProject(dir));
  const liveOperation = runtime?.operation;
  const operation = !executing && queued ? { ...liveOperation, stage: "queued", progress: `posição ${queued.position}` }
    : holder && (!liveOperation || liveOperation.stage === "queued")
      ? { ...liveOperation, stage: project.preparation?.status === "running" ? "preparing" : holder.stage === "rendering" ? "rendering" : "analyzing" }
      : liveOperation ?? null;
  const view = activityView({ project, operation });
  const result = view.states.find(item => item.key === "result")!.detail;
  const approval = view.states.find(item => item.key === "approval")!.detail;
  const corrections = project.corrections.some(item => item.status === "pending");
  const alignmentRunning = Boolean(runtime?.alignmentActive || holder?.stage === "speech" && corrections && !preparing && !runtime?.cancellable);
  const pendingCorrection = corrections && !alignmentRunning && !busy;
  const resumeNeedsConfirm = prepareNeedsConfirm(project);
  const resumeState = ["interrupted", "attention", "cancelled"].includes(project.preparation?.status ?? "");
  const notice = [
    queueUnavailable && "Fila indisponível. Tente atualizar novamente.",
    pendingCorrection && "Correção pendente · abra o Projeto para alinhar.",
    resumeState && resumeNeedsConfirm && "Retome no Projeto para confirmar a substituição das cenas editadas.",
  ].filter(Boolean).join(" ");
  const lifecycle = await deriveLifecycle(dir, project.lifecycle, { now, busy, env: opts.env, project });
  const included = project.assembly.sources.some(source => source.included);
  const artifact = project.previewArtifact;
  const preview = artifact ? resolve(dir, artifact.relativePath) : null;
  const exportable = artifact?.revision === project.revision
    && artifact.assemblySha256 === createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex")
    && preview?.startsWith(resolve(dir) + sep)
    && (await stat(preview).catch(() => null))?.isFile()
    && project.assembly.sources.every(source => isAbsolute(source.path))
    && (await missingMedia(project)).length === 0;
  const stage = alignmentRunning && !runtime?.cancellable ? "Alinhar correção"
    : heldStage ?? (!executing ? queueStage : null) ?? view.stage;
  const text = pendingCorrection ? "Correção pendente · abra o Projeto para alinhar"
    : executing ? `Executando · ${stage}` : queued ? "Aguardando na fila" : view.text;
  return { text, busy, executing, queuedCount, queueUnavailable, notice,
    queuePosition: queued?.position ?? null, stage, media: view.media, elapsedMs,
    result, approval, error: view.error, lifecycle,
    retentionAt: ["entregue", "elegível"].includes(lifecycle.state) && lifecycle.enteredAt.entregue != null
      ? lifecycle.enteredAt.entregue + retentionMs(opts.env) : null,
    revision: project.revision,
    actions: {
      resume: !queueUnavailable && !busy && !corrections && included && resumeState && !resumeNeedsConfirm,
      cancel: runtime?.cancellable === true,
      export: !queueUnavailable && Boolean(exportable) && !busy && !corrections && project.finalApprovedRevision === project.revision && project.previewRevision === project.revision,
    } };
}
