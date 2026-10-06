import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createCredentialsReader, createFillerObserveClient, envWithStoredTypeSafe, mtimeCached, readAnalysisCredentials,
} from "@decupa/triage";
import type { Tracer } from "@decupa/trace";
import { createAssemblyDecisionContext } from "../app/assembly/assembly-decisions.ts";
import { buildReview, type ReviewUnitFlag } from "../app/review.ts";
import { DEFAULT_ENGINE, engineSupportsFillerSpans, indexPath, planPath, runPlan, transcriptPath,
  type Executor, type PipelineJob } from "../app/pipeline.ts";
import type { JobStore } from "../app/jobs.ts";
import { initialKeepList, readKeepList } from "../app/session.ts";
import { expandKeepList } from "../app/keeplist.js";
import type { CondenseTranscript } from "./prepare.ts";
import { ambiguousItems, cleanupFillers, emptyDecisions, fillerPatch, selectedFillers, validateSavedFillers, type FillerCatalog } from "./fillers.ts";
import { CleanupPlanQueue, persistFillerSession, recoverFillerSession } from "./filler-session.ts";
import { cleanupFillerNotes } from "./filler-notes.ts";

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const optional = async (path: string): Promise<unknown> => json(path).catch(error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
});

export class FillerRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Conecta a fila completa à Limpeza; os clientes e o estado da Montagem ficam fora dela. */
export function createCleanupPlanning(opts: { job: PipelineJob; exec: Executor; tracer: Tracer; store: JobStore;
  env: Record<string, string | undefined>; fetchImpl?: typeof fetch; providerConfigDir?: string;
  loadStored?: () => ReturnType<typeof readAnalysisCredentials>;
  visual: () => Promise<unknown>; flags: () => Promise<Record<string, ReviewUnitFlag[]> | undefined> }) {
  const { job, store } = opts;
  const projectDir = process.cwd();
  const readCredentials = createCredentialsReader(), readDecision = mtimeCached(optional);
  let loaded: Promise<void> | null = null, queue: CleanupPlanQueue | null = null;
  let catalog: FillerCatalog, supported = false;
  const warnings = new Map<string, string>();
  const warn = (source: string, message: string): void => {
    if (message) warnings.set(source, message); else warnings.delete(source);
    store.setFillerWarning(job.id, [...warnings.values()].join("; "));
  };
  const failedWarning = "a última mudança não foi aplicada; o corte anterior continua valendo";
  let notes: ReturnType<typeof cleanupFillerNotes> | null = null;
  let noteIds = new Set<string>();
  const signal = job.signal ?? new AbortController().signal;
  const noteContext = async () => {
    const stored = await (opts.loadStored?.() ?? readAnalysisCredentials(projectDir, opts.providerConfigDir ?? homedir(), readCredentials));
    const env = envWithStoredTypeSafe(opts.env, stored);
    const decision = createAssemblyDecisionContext(await readDecision(join(projectDir, ".decupa", "decision.json")), env, opts.fetchImpl);
    const client = decision.client ? createFillerObserveClient({ apiKey: env.TYPESAFE_API_KEY!, model: decision.model, fetchImpl: opts.fetchImpl }) : undefined;
    const key = createHash("sha256").update(JSON.stringify([env.TYPESAFE_API_KEY, env.DECUPA_TYPESAFE, decision.mode, decision.model])).digest("hex");
    return { model: decision.model, client, key };
  };
  const refreshNotes = async (): Promise<void> => {
    if (!notes) return;
    try {
      const config = await noteContext();
      // Desligar revoga a nota em voo; trocar a chave conserva seu snapshot.
      if (!config.client && store.get(job.id)?.fillerNotesPending) notes.cancel();
      else if (store.get(job.id)?.fillerNotesPending) return;
      notes.update(ambiguousItems(catalog, noteIds), ambiguousItems(catalog, new Set(catalog.candidates.map(c => c.unitId)), true), config);
    } catch { warn("notes", "configuração de decisão inválida: notas de cacoetes indisponíveis"); }
  };
  const load = (): Promise<void> => loaded ??= (async () => {
    await recoverFillerSession(job.workDir);
    const rawIndex = await json(indexPath(job)) as { units: { id: string }[]; transcript_sha256?: string };
    if (!Array.isArray(rawIndex?.units)) throw Error("índice sem unidades para planejar");
    if (!rawIndex.units.length) initialKeepList(null, []);
    const rawTranscript = await readFile(transcriptPath(job), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    const hash = rawTranscript === null ? rawIndex.transcript_sha256 ?? "" : createHash("sha256").update(rawTranscript).digest("hex");
    const unavailable = (reason: string): void => {
      catalog = { transcriptSha256: hash, candidates: [], warnings: [reason], legacyReason: reason };
    };
    try { catalog = cleanupFillers(rawIndex, rawTranscript === null ? null : JSON.parse(rawTranscript) as CondenseTranscript, hash); }
    catch { unavailable("índice ou transcrição inválidos: cacoetes por palavra indisponíveis"); }
    let savedRaw: unknown;
    try { savedRaw = await optional(join(job.workDir, "fillers.json")); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; catalog.warnings.push("decisões de cacoetes inválidas descartadas"); }
    const capable = await engineSupportsFillerSpans(opts.env.VE_PLUGIN_ROOT ?? DEFAULT_ENGINE);
    let decision: Awaited<ReturnType<typeof noteContext>> | undefined;
    try {
      decision = await noteContext();
    } catch { unavailable("configuração de decisão inválida: cacoetes por palavra indisponíveis"); }
    supported = capable && !catalog.legacyReason;
    const saved = catalog.legacyReason ? { decisions: emptyDecisions(), warnings: [] } : validateSavedFillers(savedRaw, catalog);
    catalog.warnings.push(...saved.warnings);
    // Cartão oculto precisa do banner; com grupos, o aviso legado fica só no cartão.
    warn("catalog", catalog.warnings.filter(w => !catalog.candidates.length || w !== catalog.legacyReason).join("; "));
    if (decision && !catalog.legacyReason) {
      notes = cleanupFillerNotes({ workDir: job.workDir, model: decision.model, signal,
        publish: result => store.setFillerNotes(job.id, result), warn: message => warn("notes", message),
        pending: value => store.setFillerNotesPending(job.id, value) });
    }
    queue = new CleanupPlanQueue({ generation: 0,
      keepList: initialKeepList(await readKeepList(job.workDir), rawIndex.units.map(u => u.id)), fillers: saved.decisions }, async (state, current) => {
      const oldPlan = await readFile(planPath(job), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
      });
      const restorePlan = async (): Promise<void> => {
        if (oldPlan !== null) await writeFile(planPath(job), oldPlan, "utf8");
        else await unlink(planPath(job)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      };
      try {
        signal.throwIfAborted();
        store.setStage(job.id, "planning");
        const ids = new Set(expandKeepList(state.keepList));
        await runPlan(job, state.keepList, opts.exec, opts.tracer, {
          generation: state.generation, supported, engine: opts.env.VE_PLUGIN_ROOT ?? DEFAULT_ENGINE, spans: selectedFillers(catalog, state.fillers, ids),
        });
        signal.throwIfAborted();
        const review = buildReview(await json(planPath(job)), rawIndex, await opts.visual(), await opts.flags(), {
          generation: state.generation, catalog, decisions: state.fillers, supported,
        });
        if (!current()) { await restorePlan(); return; }
        try {
          await persistFillerSession(job.workDir, state, catalog.transcriptSha256, signal, { preserveFillers: Boolean(catalog.legacyReason) });
          warn("persistence", "");
        } catch {
          signal.throwIfAborted();
          // A rotina de gravação recupera o par anterior. O plano válido continua na tela.
          warn("persistence", "não consegui gravar a sessão; ela não será retomada com esta mudança");
        }
        store.setReview(job.id, review, state.keepList);
        warn("plan", "");
        noteIds = ids;
        await refreshNotes();
      } catch (error) {
        await restorePlan();
        if (current()) {
          if (store.get(job.id)?.review) {
            store.setStage(job.id, "ready");
            warn("plan", failedWarning);
          } else store.fail(job.id, error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    });
  })().catch(error => { loaded = null; throw error; });
  return {
    replan: async (keepList?: string): Promise<void> => { await load(); return queue!.update(keepList === undefined ? {} : { keepList }); },
    fillers: async (raw: unknown): Promise<void> => {
      await load();
      if (!supported) throw new FillerRequestError(409, catalog.legacyReason ?? "motor sem suporte a corte por palavra; atualize o motor");
      let patch: ReturnType<typeof fillerPatch>;
      try { patch = fillerPatch(raw, catalog); }
      catch (error) { throw new FillerRequestError(400, error instanceof Error ? error.message : String(error)); }
      return queue!.update({ fillers: patch });
    },
    generation: (): number => queue?.desired.generation ?? 0,
    planning: (): boolean => queue?.planning ?? false,
    refreshNotes,
    cancelNotes: (): void => { notes?.cancel(); },
    close: async (): Promise<void> => { await notes?.close(); },
  };
}
