import { createHash } from "node:crypto";
import { relative } from "node:path";
import { hashFile } from "@decupa/media";
import type { Executor } from "../pipeline.ts";
import { analyzeSource } from "./analysis.ts";
import { ensurePlayback, verifySourceIdentity } from "./media.ts";
import { describeSource } from "./model.ts";
import { renderAssembly } from "./render.ts";
import { applyProposal, recordPreview } from "./revisions.ts";
import { proposeScenes } from "./scenes.ts";
import { loadProject, mergeAnalyses, saveProject } from "./store.ts";
import { visualCoverage } from "./visual.ts";
import { buildPeaks, peaksPath } from "./waveform.ts";
import type { Preparation, PreviewArtifact, Project, Source } from "./types.ts";

export type PreparationMode = "prepare" | "adjust" | "preview";

export type PreparationRequest = {
  mode: PreparationMode;
  request: string;
  modelOptIn: boolean;
  visualOptIn: boolean;
};

export type ModelTransport = {
  send(content: unknown[], signal?: AbortSignal): Promise<string>;
};

export type PreparationDeps = {
  exec: Executor;
  proposeSend?: ModelTransport["send"];
  describeClient?: ModelTransport;
};

export type PreparationControl = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

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

export function isPreparationActive(dir: string): boolean {
  return (prepActive.get(dir) ?? 0) > 0;
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
): Promise<PreviewArtifact> {
  const reference = await renderAssembly(project.assembly, dir, exec);
  return {
    revision: project.revision,
    assemblySha256: createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
  };
}

function needsAttention(project: Project): boolean {
  const analysisError = project.analyses.some((analysis) => analysis.status === "error");
  const missingVisual = project.analyses.flatMap((analysis) => analysis.visualCoverage.missing).length;
  const stageError = Object.values(project.preparation?.sources ?? {}).some(
    (stage) => stage.media === "error" || stage.audio === "error" || stage.visual === "error",
  );
  return analysisError || stageError || missingVisual > 0;
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
    const checkAlive = (): void => {
      if (signal.aborted) throw new CancelledExit();
      if (!control.isCurrent()) throw new ObsoleteExit();
    };

    const markTerminal = async (
      status: "ready" | "attention" | "interrupted" | "cancelled",
      error?: string,
    ): Promise<Project> => {
      try {
        const fresh = await loadProject(dir);
        if (fresh.preparation?.id !== id) return fresh;
        await saveProject(dir, fresh.revision, (p) =>
          p.preparation?.id === id
            ? { ...p, preparation: { ...p.preparation, status, ...(error ? { error } : {}) } }
            : p);
        return await loadProject(dir);
      } catch {
        return await loadProject(dir);
      }
    };

    let current: Project;
    try {
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

      // Rebase sobre a revisão atual: a edição passou na frente e o save
      // com a revisão capturada falha; aplica fn sobre o estado novo.
      // Impossível só se a fonte sumiu no meio: persiste o produzido e
      // interrompe retomável em vez de falhar.
      const rebaseSave = async (fn: (p: Project) => Project): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          checkAlive();
          const fresh = await loadProject(dir);
          if (fresh.preparation?.id !== id) throw new ObsoleteExit();
          const missing = targets.filter((source) =>
            !fresh.assembly.sources.some((item) => item.id === source.id));
          try {
            await saveProject(dir, fresh.revision, (p) =>
              p.preparation?.id === id ? fn(p) : p);
          } catch (err) {
            if (!(err instanceof Error) || !/revisão desatualizada/.test(err.message)) throw err;
            continue;
          }
          if (missing.length > 0) {
            await markTerminal(
              "interrupted",
              `fonte removida durante a preparação: ${missing.map((s) => s.id).join(", ")}; retome para prosseguir`,
            );
            throw new InterruptedExit();
          }
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
      };
      const atStage = async (stage: Preparation["stage"]): Promise<void> => {
        await save((p) => ({
          ...p,
          preparation: p.preparation ? { ...p.preparation, stage } : p.preparation,
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
          try {
            await verifySourceIdentity(source);
            await markSource(source.id, { media: "ready" });
          } catch (err) {
            await markSource(source.id, {
              media: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (current.preparation?.sources[source.id]?.media !== "ready") continue;
          // Peaks de waveform (Task 8): após o proxy existir, best-effort —
          // nunca marca erro na fonte nem entra no caminho crítico.
          try {
            const { videoPath } = await ensurePlayback(source, dir, deps.exec);
            await buildPeaks(deps.exec, {
              proxyPath: videoPath,
              sha256: source.sha256,
              outPath: peaksPath(dir, source.sha256),
              durationSeconds: source.durationSeconds,
            });
          } catch {
            // Sem waveform a faixa segue só com os blocos.
          }
        }

        await atStage("audio");
        for (const source of targets) {
          checkAlive();
          if (current.preparation?.sources[source.id]?.media !== "ready") continue;
          try {
            const analysis = await analyzeSource(source, dir, deps.exec);
            checkAlive();
            await save((p) => ({
              ...p,
              analyses: mergeAnalyses(p.analyses, [analysis]),
              preparation: p.preparation
                ? patchSource(p.preparation, source.id, {
                  audio: analysis.status === "error" ? "error" : "ready",
                  ...(analysis.status === "error" && analysis.error ? { error: analysis.error } : {}),
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

        await atStage("visual");
        for (const source of targets) {
          checkAlive();
          if (current.preparation?.sources[source.id]?.media !== "ready") continue;
          if (!source.hasVideo) {
            await markSource(source.id, { visual: "ready" });
            continue;
          }
          if (!deps.describeClient) continue;
          try {
            const spans = await describeSource(source, dir, signal, {
              client: deps.describeClient,
              exec: deps.exec,
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
                    error: gap,
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
        const blocked = targets.filter((source) => {
          const state = current.preparation?.sources[source.id];
          if (!state) return true;
          if (state.media !== "ready" || state.audio !== "ready") return true;
          if (source.hasVideo && deps.describeClient) {
            if (state.visual !== "ready") return true;
            const coverage = current.analyses.find((item) => item.sourceId === source.id)?.visualCoverage;
            if (!coverage || coverage.missing.length > 0) return true;
          }
          const analysis = current.analyses.find((item) => item.sourceId === source.id);
          if (!analysis || analysis.status === "error") return true;
          return false;
        });
        if (blocked.length > 0) {
          return await markTerminal(
            "interrupted",
            `análise necessária pendente nas fontes: ${blocked.map((s) => s.id).join(", ")}; retome ou exclua a fonte para prosseguir`,
          );
        }

        const speechTotal = current.analyses
          .filter((analysis) => byId.get(analysis.sourceId)?.included !== false)
          .flatMap((analysis) => analysis.speech).length;
        if (speechTotal === 0) {
          return await markTerminal("interrupted", "sem fala transcrita nas fontes incluídas");
        }

        await atStage("proposal");
        checkAlive();
        let proposal;
        try {
          proposal = await proposeScenes(current, req.request, signal, { send: deps.proposeSend! });
        } catch (err) {
          checkAlive();
          return await markTerminal(
            "interrupted",
            `proposta rejeitada: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        checkAlive();
        try {
          await saveProject(dir, current.revision, (p) =>
            p.preparation?.id === id ? applyProposal(p, proposal) : p);
          current = await loadProject(dir);
        } catch (err) {
          checkAlive();
          return await markTerminal(
            "interrupted",
            err instanceof Error ? err.message : String(err),
          );
        }
        if (current.preparation?.id !== id) throw new ObsoleteExit();
      }

      await atStage("preview");
      checkAlive();
      try {
        const artifact = await renderPreview(dir, current, deps.exec);
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
      if (err instanceof ObsoleteExit) return await loadProject(dir);
      if (err instanceof CancelledExit) return await markTerminal("cancelled");
      throw err;
    }
  });
}
