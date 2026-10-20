import { autoFillerTargets } from "./fillers.ts";
import { planFillerSnaps } from "./filler-snaps.ts";
import { observeAssemblyFillers, type FillerObserveDeps } from "./filler-observe.ts";
import type { AssemblyDecisionContext } from "./assembly-decisions.ts";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { publishAtomic } from "@decupa/cache";
import { createOperationMetrics, instrumentCoordinator, instrumentSpeechWorker, type OperationMetrics } from "@decupa/bench";
import { hashFile } from "@decupa/media";
import type { Executor, IngestSpeech } from "../pipeline.ts";
import type { FileCoordinator } from "@decupa/coordinator";
import { analyzeSource } from "./analysis.ts";
import { ensurePlayback, verifySourceIdentity } from "./media.ts";
import { describeSource, type VisualMetric } from "./model.ts";
import { renderAssembly } from "./render.ts";
import { applyProposalWithFillers, proposalProject, recordPreview } from "./revisions.ts";
import { proposeScenes, proposalStateKey } from "./scenes.ts";
import { loadProject, mergeAnalyses, saveProject, writeHistorySnapshot } from "./store.ts";
import { visualCoverage } from "./visual.ts";
import { buildPeaks, peaksPath } from "./waveform.ts";
import type { Preparation, PreviewArtifact, Project, Source } from "./types.ts";
import { recordUndo } from "./undo.ts";

export type PreparationMode = "prepare" | "adjust" | "preview";

export type PreparationRequest = {
  mode: PreparationMode;
  request: string;
  modelOptIn: boolean;
  visualOptIn: boolean;
};

export type ModelTransport = {
  send(content: unknown[], signal?: AbortSignal, onAttempt?: () => void): Promise<string>;
  model?: string;
  providerKey?: string;
};

export type PreparationDeps = FillerObserveDeps & {
  decision?: AssemblyDecisionContext;
  exec: Executor;
  proposeSend?: ModelTransport["send"];
  describeClient?: ModelTransport;
  speech?: IngestSpeech;
  coordinator?: FileCoordinator;
  onStage?: (stage: "queued" | "transcribing" | "indexing" | "visual") => void;
  onMetric?: (metric: VisualMetric) => void;
};

export type PreparationControl = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

const PREVIEW_IMAGE_PENDING_NOTE = "prévia aguardando proxy e waveform";
export const CORRECTION_SETTLE_TIMEOUT_MS = 30_000;
const CORRECTION_SETTLE_POLL_MS = 250;
const TERMINAL = new Set(["ready", "attention", "interrupted", "cancelled"]);

class CancelledExit extends Error {
  constructor() {
    super("preparação cancelada");
  }
}

class ObsoleteExit extends Error {
  constructor() {
    super("preparação obsoleta");
  }
}

/** Terminal já registrado (interrupted retomável): só retorna o estado atual. */
class InterruptedExit extends Error {
  constructor() {
    super("preparação interrompida");
  }
}

/** O transporte só decide; o fluxo principal persiste fora da corrida de cancelamento. */
class ProposalBlockedExit extends Error {}

/** Opt-in pago é monotônico: nunca revoga uma permissão já concedida. */
export function withGrantedPermissions(
  project: Project,
  grants: { model?: boolean; visual?: boolean },
): Project {
  const model = project.permissions.model || grants.model === true;
  const visual = project.permissions.visual || grants.visual === true;
  if (model === project.permissions.model && visual === project.permissions.visual) {
    return project;
  }
  return { ...project, permissions: { model, visual } };
}

/**
 * Um percurso por diretório: inícios concorrentes na mesma base colapsam
 * num único trabalho; o perdedor adota o resultado em vez de duplicar.
 */
const prepLocks = new Map<string, Promise<void>>();
const prepActive = new Map<string, number>();
const prepHeld = new Map<string, number>();

export function isPreparationActive(dir: string): boolean {
  return (prepActive.get(dir) ?? 0) > 0 || (prepHeld.get(dir) ?? 0) > 0;
}

/** Keeps GET /project from treating an in-flight POST as an orphan restart. */
export function holdPreparation(dir: string): () => void {
  prepHeld.set(dir, (prepHeld.get(dir) ?? 0) + 1);
  return () => {
    const next = (prepHeld.get(dir) ?? 1) - 1;
    if (next <= 0) prepHeld.delete(dir);
    else prepHeld.set(dir, next);
  };
}

async function withPreparationLock<T>(dir: string, fn: (contended: boolean) => Promise<T>): Promise<T> {
  const prev = prepLocks.get(dir);
  const contended = (prepActive.get(dir) ?? 0) > 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = (prev ?? Promise.resolve()).then(() => gate);
  prepLocks.set(dir, chained);
  if (prev) await prev.catch(() => undefined);
  prepActive.set(dir, (prepActive.get(dir) ?? 0) + 1);
  try {
    return await fn(contended);
  } finally {
    prepActive.set(dir, Math.max(0, (prepActive.get(dir) ?? 1) - 1));
    release();
    if (prepLocks.get(dir) === chained) prepLocks.delete(dir);
  }
}

function patchSource(
  preparation: Preparation,
  sourceId: string,
  patch: Partial<Preparation["sources"][string]>,
): Preparation {
  const current = preparation.sources[sourceId] ?? { media: "pending", audio: "pending", visual: "pending" };
  return {
    ...preparation,
    sources: { ...preparation.sources, [sourceId]: { ...current, ...patch } },
  };
}

async function renderPreview(
  dir: string,
  project: Project,
  exec: Executor,
  signal?: AbortSignal,
  coordinator?: FileCoordinator,
  status?: { onQueued?: () => void; onStarted?: () => void },
): Promise<PreviewArtifact> {
  const reference = await renderAssembly(project.assembly, dir, exec, {
    detectHardware: true,
    signal,
    coordinator,
    onQueued: status?.onQueued,
    onStarted: status?.onStarted,
  });
  return {
    revision: project.revision,
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
  };
}

function needsAttention(project: Project): boolean {
  const includedSources = new Set(project.assembly.sources.filter((source) => source.included).map((source) => source.id));
  const analysisError = project.analyses.some(
    (analysis) => includedSources.has(analysis.sourceId) && analysis.status === "error",
  );
  const missingVisual = project.analyses.flatMap((analysis) => analysis.visualCoverage.missing).length;
  const stageError = Object.values(project.preparation?.sources ?? {}).some(
    (stage) => stage.media === "error" || stage.audio === "error" || stage.visual === "error",
  );
  return analysisError || stageError || missingVisual > 0;
}

/** Áudio zera a evidência visual antes de a etapa visual repô-la do cache. */
function proposalCleanupKey(project: Project): string {
  return proposalStateKey({
    ...project,
    analyses: project.analyses.map(analysis => ({
      ...analysis, visual: [], visualCoverage: { requested: [], returned: [], missing: [] },
    })),
  });
}

/**
 * Percurso prepare/adjust/preview até cenas+prévia atuais, sem cliques
 * intermediários. Resolve com o projeto final em todo desfecho esperado
 * (ready/attention/interrupted/cancelled); rejeita só em uso indevido
 * (revisão antiga, adjust sem cenas, transporte ausente).
 */
export async function runPreparation(
  dir: string,
  baseRevision: number,
  req: PreparationRequest,
  deps: PreparationDeps,
  control: PreparationControl,
): Promise<Project> {
  const metrics = createOperationMetrics({
    dir: join(dir, ".decupa", "metrics"),
    metadata: { operation: req.mode, baseRevision },
  });
  const exec: Executor = { run: call => metrics.tracer.run(`process:${basename(call.command)}`,
    async () => {
      const result = await deps.exec.run(call);
      metrics.emit("process-call", { command: basename(call.command), code: result.code });
      return result;
    }, { signal: call.signal }) };
  const speech = deps.speech ? { ...deps.speech,
    worker: instrumentSpeechWorker(deps.speech.worker, metrics),
    coordinator: instrumentCoordinator(deps.speech.coordinator, metrics),
  } : undefined;
  try {
    const result = await metrics.tracer.run("preparation", () => runPreparationOperation(dir, baseRevision, req, {
      ...deps, exec, speech,
      coordinator: instrumentCoordinator(deps.coordinator, metrics),
      onStage: stage => { metrics.emit("stage", { stage }); deps.onStage?.(stage); },
      onMetric: metric => {
        metrics.emit("visual", metric);
        try { deps.onMetric?.(metric); } catch { /* Observability does not interrupt editing. */ }
      },
    }, control, metrics));
    metrics.emit("preparation-result", { status: result.preparation?.status, revision: result.revision });
    return result;
  } finally { await metrics.close(); }
}

async function runPreparationOperation(
  dir: string,
  baseRevision: number,
  req: PreparationRequest,
  deps: PreparationDeps,
  control: PreparationControl,
  metrics: OperationMetrics,
): Promise<Project> {
  return withPreparationLock(dir, async (contended) => {
    const opened = await loadProject(dir);
    const prior = opened.preparation;
    // Início concorrente na mesma base colapsa: adota o desfecho em vez de
    // duplicar. Nova tentativa sequencial reexecuta (inclusive após
    // falha ou cancelamento).
    if (
      contended && prior && prior.revision === baseRevision && prior.mode === req.mode &&
      TERMINAL.has(prior.status) && prior.status !== "cancelled"
    ) {
      return opened;
    }
    if (opened.revision !== baseRevision) {
      throw new Error(`revisão desatualizada: base ${baseRevision}, atual ${opened.revision}`);
    }
    if (req.mode === "adjust" && opened.scenes.length === 0) {
      throw new Error("nada a ajustar: ainda não há cenas; use prepare");
    }
    if (req.mode !== "preview" && !deps.proposeSend) {
      throw new Error("sem transporte de modelo: autorize o uso pago ou rode offline");
    }

    const id = `prep-${baseRevision}-${req.mode}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const { signal } = control;
    const imageAbort = new AbortController();
    const imageSignal = AbortSignal.any([signal, imageAbort.signal]);
    const imageJobs: Promise<void>[] = [];
    let imagesDone: Promise<void> | undefined;
    let imageFinished = true;
    let operationDeps = deps;
    const checkpointPath = join(dir, ".decupa", req.mode === "adjust"
      ? "proposal-adjust-checkpoint.json" : "proposal-checkpoint.json");
    const otherCheckpointPath = join(dir, ".decupa", req.mode === "adjust"
      ? "proposal-checkpoint.json" : "proposal-adjust-checkpoint.json");
    let checkpointBaseKey: string | undefined;
    let checkpointDisabled = false;
    const checkpointWarning = (action: "read" | "write" | "remove", error: unknown): void => {
      checkpointDisabled = true;
      // Nunca registre texto do modelo, pedidos Jev ou mensagens de I/O.
      metrics.emit("checkpoint-warning", { action, code: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN" });
    };
    const discardCheckpoint = async (path = checkpointPath): Promise<void> => {
      try { await unlink(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") checkpointWarning("remove", error);
      }
    };
    const discardUnresumableCheckpoint = async (): Promise<void> => {
      if (req.mode === "preview") return;
      let stateKey = checkpointBaseKey;
      const beforeProposal = stateKey === undefined;
      if (stateKey === undefined) {
        // Cancelamento pode chegar antes da proposta. O metadado local permite
        // limpar uma entrada antiga sem confundir a etapa visual transitória
        // com uma edição. O replay continua exigindo a chave exata em load.
        try {
          const cached = JSON.parse(await readFile(checkpointPath, "utf8")) as { cleanupKey?: unknown } | null;
          if (typeof cached?.cleanupKey === "string") stateKey = cached.cleanupKey;
        } catch (error) {
          if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") checkpointWarning("read", error);
          return;
        }
      }
      if (stateKey !== undefined) {
        const fresh = await loadProject(dir);
        if ((beforeProposal ? proposalCleanupKey(fresh) : proposalStateKey(fresh)) !== stateKey) await discardCheckpoint();
      }
    };
    const checkAlive = (): void => {
      if (signal.aborted) throw new CancelledExit();
      if (!control.isCurrent()) throw new ObsoleteExit();
    };
    const settleImageJobs = async (): Promise<void> => {
      imageAbort.abort();
      await Promise.all(imageJobs).catch(() => undefined);
    };

    const markTerminal = async (
      status: "ready" | "attention" | "interrupted" | "cancelled",
      error?: string,
    ): Promise<Project> => {
      await settleImageJobs();
      try {
        const fresh = await loadProject(dir);
        if (fresh.preparation?.id !== id) return fresh;
        await saveProject(dir, fresh.revision, (p) =>
          p.preparation?.id === id
            ? { ...p, preparation: { ...p.preparation, status, ...(error ? { error } : {}) } }
            : p);
        const terminal = await loadProject(dir);
        if (terminal.preparation?.id === id && (status === "ready" || status === "attention")) {
          // Desligar revoga também notas que a preparação ainda não despachou.
          const active = await deps.resolveOperationDeps?.().catch(() => null);
          if (!deps.resolveOperationDeps || active?.decision.client) {
            void observeAssemblyFillers(dir, terminal, { ...operationDeps, resolveOperationDeps: undefined }).catch(() => undefined);
          }
        }
        return terminal;
      } catch {
        return await loadProject(dir);
      }
    };

    let current: Project;
    try {
      operationDeps = { ...deps, ...await deps.resolveOperationDeps?.() };
      const send = operationDeps.proposeSend;
      if (send) operationDeps = { ...operationDeps, proposeSend: (content, signal, onAttempt) => {
        metrics.emit("model-call", { purpose: "proposal" });
        return metrics.tracer.run("proposal-call", () => send(content, signal, onAttempt));
      } };
      const visualClient = operationDeps.describeClient;
      const included = opened.assembly.sources.filter((source) => source.included);
      const claim: Preparation = {
        id,
        revision: baseRevision,
        mode: req.mode,
        request: req.request,
        status: "running",
        stage: req.mode === "preview" ? "preview" : "media",
        sources:
          req.mode === "preview"
            ? {}
            : Object.fromEntries(
              included.map((source) => [
                source.id,
                { media: "pending", audio: "pending", visual: "pending" },
              ]),
            ),
      };
      // Reivindica antes de qualquer cheque de vida: um cancelamento que
      // chega antes do claim ainda assim deixa registro terminal (e nunca
      // sobrescreve um percurso mais novo — obsolescência retorna sem
      // escrever).
      if (!control.isCurrent()) return await loadProject(dir);
      await saveProject(dir, baseRevision, (p) => ({
        ...withGrantedPermissions(p, { model: req.modelOptIn, visual: req.visualOptIn }),
        preparation: claim,
      }));
      current = await loadProject(dir);
      if (current.preparation?.id !== id) return current;

      const byId = new Map<string, Source>(current.assembly.sources.map((source) => [source.id, source]));
      const targets = included.filter((source) => byId.has(source.id));
      const targetIds = new Set(targets.map((source) => source.id));
      const removedSourceReason = (project: Project): string | null => {
        const missing = targets.filter((source) =>
          !project.assembly.sources.some((item) => item.id === source.id));
        return missing.length > 0
          ? `fonte removida durante a preparação: ${missing.map((s) => s.id).join(", ")}; retome para prosseguir`
          : null;
      };
      const assertSourcesPresent = async (project: Project): Promise<void> => {
        const reason = removedSourceReason(project);
        if (reason) {
          await markTerminal("interrupted", reason);
          throw new InterruptedExit();
        }
      };

      // Rebase sobre a revisão atual: a edição passou na frente e o save
      // com a revisão capturada falha; aplica fn sobre o estado novo.
      // Impossível só se a fonte sumiu no meio: persiste o produzido e
      // interrompe retomável em vez de falhar.
      const rebaseSave = async (fn: (p: Project) => Project): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          checkAlive();
          const fresh = await loadProject(dir);
          if (fresh.preparation?.id !== id) throw new ObsoleteExit();
          try {
            await saveProject(dir, fresh.revision, (p) =>
              p.preparation?.id === id ? fn(p) : p);
          } catch (err) {
            if (!(err instanceof Error) || !/revisão desatualizada/.test(err.message)) throw err;
            continue;
          }
          await assertSourcesPresent(fresh);
          return;
        }
        await markTerminal("interrupted", "edição concorrente durante a preparação; retome para prosseguir");
        throw new InterruptedExit();
      };

      // Save do percurso com rebase (Task 11): quando a revisão avançou
      // (edição passou na frente), não falha com 409 genérico — aplica as
      // mutações de análise/preparação sobre `current`, nunca scenes ou
      // corrections, e o percurso segue até ready.
      const save = async (fn: (p: Project) => Project): Promise<void> => {
        checkAlive();
        try {
          await saveProject(dir, current.revision, (p) =>
            p.preparation?.id === id ? fn(p) : p);
        } catch (err) {
          if (!(err instanceof Error) || !/revisão desatualizada/.test(err.message)) throw err;
          checkAlive();
          await rebaseSave(fn);
        }
        current = await loadProject(dir);
        if (current.preparation?.id !== id) throw new ObsoleteExit();
        await assertSourcesPresent(current);
      };
      const atStage = async (stage: Preparation["stage"]): Promise<void> => {
        metrics.emit("stage", { stage });
        await save((p) => ({
          ...p,
          preparation: p.preparation ? { ...p.preparation, stage, note: undefined } : p.preparation,
        }));
      };
      const markSource = async (
        sourceId: string,
        patch: Partial<Preparation["sources"][string]>,
      ): Promise<void> => {
        await save((p) => ({
          ...p,
          preparation: p.preparation ? patchSource(p.preparation, sourceId, patch) : p.preparation,
        }));
      };

      if (req.mode !== "preview") {
        for (const source of targets) {
          checkAlive();
          await markSource(source.id, { media: "running" });
          try {
            await metrics.tracer.run("source-identity", () => verifySourceIdentity(source));
            await markSource(source.id, { media: "ready" });
          } catch (err) {
            await markSource(source.id, {
              media: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (current.preparation?.sources[source.id]?.media !== "ready") continue;
          // Waveform e miniatura não bloqueiam o áudio: a identidade já
          // autorizou a transcrição. Promessa sempre observada.
          const image = Promise.resolve().then(async () => {
            try {
              const { videoPath } = await ensurePlayback(source, dir, deps.exec, { signal: imageSignal, detectHardware: true });
              await buildPeaks(deps.exec, {
                proxyPath: videoPath,
                sha256: source.sha256,
                outPath: peaksPath(dir, source.sha256),
                durationSeconds: source.durationSeconds,
                signal: imageSignal,
              });
            } catch {
              // Sem waveform a faixa segue só com os blocos.
            }
          });
          imageJobs.push(image);
        }

        await atStage("audio");
        for (const source of targets) {
          checkAlive();
          if (current.preparation?.sources[source.id]?.media !== "ready") continue;
          try {
            let analysisBuilt = false;
            const analysis = await metrics.tracer.run("analysis", () => analyzeSource(source, dir, deps.exec, {
              signal,
              speech: deps.speech,
              heavyCoordinator: deps.coordinator,
              onStage: stage => { analysisBuilt = true; deps.onStage?.(stage); },
            }));
            metrics.emit("cache", { stage: "analysis", sourceId: source.id,
              outcome: analysisBuilt ? "built" : analysis.status !== "ready" ? "error"
                : source.hasAudio ? "hit-or-shared" : "not-applicable" });
            checkAlive();
            await save((p) => ({
              ...p,
              analyses: mergeAnalyses(p.analyses, [analysis]),
              preparation: p.preparation
                ? patchSource(p.preparation, source.id, {
                  // Só a leitura concluída do índice comprova a modalidade de
                  // fala, inclusive quando o resultado válido é vazio.
                  audio: analysis.status === "ready" ? "ready" : "error",
                  error: analysis.status === "ready"
                    ? undefined
                    : analysis.error ?? "evidência de fala incompleta",
                })
                : p.preparation,
            }));
          } catch (err) {
            checkAlive();
            await markSource(source.id, {
              audio: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const mediaArtifactsDone = Promise.all(imageJobs).then(() => undefined);
        imagesDone = mediaArtifactsDone;
        imageFinished = false;
        void mediaArtifactsDone.then(() => {
          imageFinished = true;
        });
        await atStage("visual");
        for (const source of targets) {
          checkAlive();
          if (current.preparation?.sources[source.id]?.media !== "ready") continue;
          if (!source.hasVideo) {
            await markSource(source.id, { visual: "ready" });
            continue;
          }
          if (!visualClient) continue;
          await markSource(source.id, { visual: "running" });
          try {
            const spans = await describeSource(source, dir, signal, {
              client: visualClient,
              onMetric: deps.onMetric,
              exec: deps.exec,
              isCurrent: control.isCurrent,
              coordinator: deps.coordinator,
              onQueued: () => deps.onStage?.("queued"),
              onStarted: () => deps.onStage?.("visual"),
            });
            checkAlive();
            const coverage = visualCoverage(spans, source.durationSeconds);
            // Lacuna mantém a etapa incompleta (não pronta): a barreira
            // impede proposta/render e Retomar completa só o faltante.
            const gap = coverage.missing.length > 0
              ? `cobertura visual incompleta: sem evidência em ${
                coverage.missing.map((range) => `${range.start}s–${range.end}s`).join(", ")
              }`
              : undefined;
            await save((p) => {
              const previous = p.analyses.find((analysis) => analysis.sourceId === source.id);
              const merged = mergeAnalyses(p.analyses, [{
                sourceId: source.id,
                key: previous?.key ?? source.sha256,
                speech: previous?.speech ?? [],
                visual: spans,
                status: previous?.status ?? "ready",
                ...(previous?.error ? { error: previous.error } : {}),
                words: previous?.words ?? [],
                wordsStatus: previous?.wordsStatus ?? "ready",
                visualCoverage: coverage,
              }]);
              return {
                ...p,
                analyses: merged,
                preparation: p.preparation
                  ? patchSource(p.preparation, source.id, {
                    visual: gap ? "pending" : "ready",
                    // Concluir visão não apaga a causa da falha de fala.
                    error: p.preparation.sources[source.id]?.audio === "error"
                      ? p.preparation.sources[source.id]?.error
                      : gap,
                  })
                  : p.preparation,
              };
            });
          } catch (err) {
            checkAlive();
            await markSource(source.id, {
              visual: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Barreira anterior à proposta: fonte incluída com etapa necessária
        // pendente/com erro impede a montagem parcial. Vale para todas as
        // modalidades aplicáveis — mídia, áudio e, em fonte com vídeo,
        // visual com cobertura completa — além da análise. Lacuna de
        // cobertura mantém a etapa incompleta e impede proposta/render;
        // Retomar solicita só o faltante. O progresso segue persistido;
        // prosseguir sem a fonte exige excluí-la explicitamente do conjunto.
        const proposalBlockedReason = (project: Project): string | null => {
          const includedSources = project.assembly.sources.filter((source) => source.included);
          // O percurso tem alvos fixos para não prolongar a fila pesada com
          // inclusões em voo. Retomar captura o conjunto novo e usa os caches.
          // Sem áudio nem visão exigida, não há análise adicional a aguardar.
          const added = includedSources.filter((source) => !targetIds.has(source.id) &&
            (source.hasAudio || (source.hasVideo && visualClient)));
          if (added.length > 0) {
            return `fonte incluída durante a preparação: ${added.map((source) =>
              `${source.id} (${source.name})`).join("; ")}; retome para analisar ou exclua a fonte para prosseguir`;
          }
          const includedIds = new Set(includedSources.map((source) => source.id));
          const blocked = includedSources.filter((source) => targetIds.has(source.id)).filter((source) => {
            const state = project.preparation?.sources[source.id];
            if (!state) return true;
            if (state.media !== "ready" || state.audio !== "ready") return true;
            if (source.hasVideo && deps.describeClient) {
              if (state.visual !== "ready") return true;
              const coverage = project.analyses.find((item) => item.sourceId === source.id)?.visualCoverage;
              if (!coverage || coverage.missing.length > 0) return true;
            }
            const analysis = project.analyses.find((item) => item.sourceId === source.id);
            if (!analysis || analysis.status !== "ready") return true;
            return false;
          });
          if (blocked.length > 0) {
            return `análise necessária pendente nas fontes: ${blocked.map((source) => {
              const state = project.preparation?.sources[source.id];
              const analysis = project.analyses.find((item) => item.sourceId === source.id);
              const cause = state?.audio !== "ready" && analysis?.error
                ? analysis.error
                : state?.error ?? "evidência necessária incompleta";
              return `${source.id} (${source.name}): ${cause}`;
            }).join("; ")}; retome ou exclua a fonte para prosseguir`;
          }

          const speechTotal = project.analyses
            .filter((analysis) => includedIds.has(analysis.sourceId))
            .flatMap((analysis) => analysis.speech).length;
          if (speechTotal === 0) return "sem fala transcrita nas fontes incluídas";
          return null;
        };
        const blockedReason = proposalBlockedReason(current);
        if (blockedReason) return await markTerminal("interrupted", blockedReason);

        await atStage("proposal");
        checkAlive();
        // P4 pode estar aguardando o slot que a análise de áudio acabou de
        // liberar. Espere sem adquirir slot pesado antes de pagar pelo texto:
        // o assentamento muda as palavras efetivas e a chave H4 sem revisão.
        const correctionDeadline = Date.now() + CORRECTION_SETTLE_TIMEOUT_MS;
        while (current.corrections.some((correction) => correction.status === "pending")) {
          checkAlive();
          const remaining = correctionDeadline - Date.now();
          if (remaining <= 0) {
            return await markTerminal("interrupted", "correção em alinhamento em background; retome em instantes");
          }
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, Math.min(CORRECTION_SETTLE_POLL_MS, remaining));
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted) finish();
          });
          checkAlive();
          current = await loadProject(dir);
          if (current.preparation?.id !== id) throw new ObsoleteExit();
          await assertSourcesPresent(current);
        }
        checkAlive();
        const settledBlockedReason = proposalBlockedReason(current);
        if (settledBlockedReason) return await markTerminal("interrupted", settledBlockedReason);
        const proposalBase = structuredClone(current);
        const proposalBaseKey = proposalStateKey(proposalBase);
        const proposalCleanupBaseKey = proposalCleanupKey(proposalBase);
        checkpointBaseKey = proposalBaseKey;
        const assertProposalBase = (project: Project): void => {
          if (proposalStateKey(project) !== proposalBaseKey) {
            throw new Error("entrada da proposta mudou durante a preparação; edição preservada, retome para prosseguir");
          }
        };
        let proposal;
        try {
          proposal = await proposeScenes(proposalBase, req.request, signal, {
            send: async (content, requestSignal, onAttempt) => {
              // A leitura do checkpoint (ou o reparo JSON) cede o controle
              // depois da barreira. Revalide antes de chamar o transporte pago.
              checkAlive();
              const fresh = await loadProject(dir);
              checkAlive();
              if (fresh.preparation?.id !== id) throw new ObsoleteExit();
              const reason = removedSourceReason(fresh) ?? proposalBlockedReason(fresh);
              if (reason) throw new ProposalBlockedExit(reason);
              return operationDeps.proposeSend!(content, requestSignal, onAttempt);
            }, decision: operationDeps.decision,
            configKey: operationDeps.proposalConfigKey ?? operationDeps.fillerConfigKey,
            checkpoint: {
              load: async (key) => {
                let cached: unknown;
                try { cached = JSON.parse(await readFile(checkpointPath, "utf8")); }
                catch (error) {
                  if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") checkpointWarning("read", error);
                  return null;
                }
                if (cached && typeof cached === "object" && "key" in cached && cached.key !== key) {
                  await discardCheckpoint();
                  return null;
                }
                return cached;
              },
              save: async (checkpoint) => {
                checkAlive();
                const fresh = await loadProject(dir);
                if (fresh.preparation?.id !== id) throw new ObsoleteExit();
                assertProposalBase(fresh);
                if (!checkpointDisabled) {
                  try {
                    await publishAtomic(checkpointPath, `${JSON.stringify({ ...checkpoint, cleanupKey: proposalCleanupBaseKey })}\n`, { durable: true });
                  } catch (error) { checkpointWarning("write", error); }
                }
                checkAlive();
              },
            }, onDecision: async (note) => {
              checkAlive();
              await save(p => ({...p, preparation: p.preparation ? {...p.preparation, note} : null}));
            },
          });
        } catch (err) {
          if (err instanceof ObsoleteExit || err instanceof CancelledExit || err instanceof InterruptedExit) throw err;
          checkAlive();
          if (err instanceof ProposalBlockedExit) return await markTerminal("interrupted", err.message);
          return await markTerminal(
            "interrupted",
            `proposta rejeitada: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        checkAlive();
        try {
          const proposed = proposalProject(proposalBase, proposal);
          const snaps = await planFillerSnaps(proposed, autoFillerTargets(proposed, req.mode === "prepare" ? undefined : proposal.changedSceneIds), { exec: deps.exec, signal });
          checkAlive();
          assertProposalBase(await loadProject(dir));
          await writeHistorySnapshot(dir, proposalBase);
          checkAlive();
          // As cenas trocadas viram um passo do desfazer. Só o Preparar marca a
          // revisão: o Ajuste com IA parte das cenas atuais, e marcá-lo
          // dispensaria a confirmação de um Retomar depois de edições à mão.
          await saveProject(dir, current.revision, (p) => {
            if (p.preparation?.id !== id) return p;
            // Functional saveProject callbacks run on the latest bytes, even
            // when expectedRevision is stale. Check inside the writer as well.
            assertProposalBase(p);
            const scoped = req.mode === "prepare" ? { ...proposal, changedSceneIds: proposal.scenes.map(s => s.id) } : proposal;
            const next = applyProposalWithFillers(p, scoped, snaps);
            const undone = recordUndo(p, next, req.mode === "adjust" ? "Ajuste com IA" : "Preparar montagem");
            return req.mode === "prepare" ? { ...undone, preparedRevision: next.revision } : undone;
          });
          current = await loadProject(dir);
          if (current.preparation?.id === id) {
            await discardCheckpoint();
            // Aplicar a proposta muda a revisão e invalida também o outro modo.
            await discardCheckpoint(otherCheckpointPath);
          }
        } catch (err) {
          checkAlive();
          return await markTerminal(
            "interrupted",
            err instanceof Error ? err.message : String(err),
          );
        }
        if (current.preparation?.id !== id) throw new ObsoleteExit();
      }

      // Proxy e peaks só servem à prévia: a descrição extrai frames do
      // original e a proposta só depende da cobertura persistida.
      if (imagesDone) {
        if (!imageFinished) {
          await save((p) => ({
            ...p,
            preparation: p.preparation
              ? { ...p.preparation, note: PREVIEW_IMAGE_PENDING_NOTE }
              : p.preparation,
          }));
        }
        await imagesDone;
      }
      await atStage("preview");
      checkAlive();
      try {
        let renderBuilt = false;
        const artifact = await renderPreview(dir, current, deps.exec, signal, deps.coordinator, {
          onQueued: () => deps.onStage?.("queued"),
          onStarted: () => { renderBuilt = true; deps.onStage?.("transcribing"); },
        });
        metrics.emit("cache", { stage: "preview", outcome: renderBuilt ? "built" : "hit-or-shared" });
        checkAlive();
        await save((p) => recordPreview(p, artifact));
      } catch (err) {
        checkAlive();
        if (req.mode === "preview") {
          return await markTerminal(
            "interrupted",
            `prévia falhou: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return await markTerminal(
          "attention",
          `prévia falhou: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return await markTerminal(needsAttention(current) ? "attention" : "ready");
    } catch (err) {
      if (err instanceof InterruptedExit) return await loadProject(dir);
      if (err instanceof ObsoleteExit || err instanceof CancelledExit) {
        await discardUnresumableCheckpoint();
        return err instanceof CancelledExit ? await markTerminal("cancelled") : await loadProject(dir);
      }
      throw err;
    }
  });
}
