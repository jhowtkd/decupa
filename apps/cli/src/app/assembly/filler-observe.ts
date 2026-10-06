import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publishAtomic } from "@decupa/cache";
import {
  createFillerObserveClient, fillerNoteKey, scoreAmbiguous, FILLER_JEV_MAX_PER_GENERATION,
  type FillerNote, type FillerObserveClient,
} from "@decupa/triage";
import type { AssemblyDecisionContext } from "./assembly-decisions.ts";
import { loadProject } from "./store.ts";
import type { Project } from "./types.ts";
import { cachedFillerReport } from "./filler-cache.ts";
import { currentFillerSnaps, decorateFillerReport, type AssemblyFillerReport, type FillerReportNotes, type FillerSnaps } from "./fillers.ts";

export type FillerObserveDeps = {
  decision?: AssemblyDecisionContext;
  fillerObserveClient?: FillerObserveClient;
  fillerEnv?: Record<string, string | undefined>;
  fillerFetchImpl?: typeof fetch;
};

type Envelope = { generation: string; notes: FillerNote[]; eligible: number; excess: number };
type Job = { generation: string; controller: AbortController; pending: boolean };
const jobs = new Map<string, Job>();
const publications = new Map<string, Promise<void>>();
const starts = new Map<string, Promise<void>>();

function observeConfig(deps: FillerObserveDeps) {
  const env = deps.fillerEnv ?? process.env;
  const context = deps.decision;
  const enabled = context && context.mode !== "off";
  // A existência de context.client não autoriza reutilizar seus retries.
  const client = enabled ? deps.fillerObserveClient ?? (env.DECUPA_TYPESAFE === "1" && env.TYPESAFE_API_KEY
    ? createFillerObserveClient({ apiKey: env.TYPESAFE_API_KEY, model: context.model, fetchImpl: deps.fillerFetchImpl }) : undefined) : undefined;
  return { client, model: context?.model };
}

export async function readAssemblyFillerNotes(dir: string): Promise<Envelope | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "fillers-notes.json"), "utf8"));
    if (typeof raw.generation !== "string" || !Array.isArray(raw.notes) || !Number.isSafeInteger(raw.eligible)
      || raw.eligible < 0 || !Number.isSafeInteger(raw.excess) || raw.excess < 0) return null;
    return raw as Envelope;
  } catch { return null; }
}

function generationItems(report: AssemblyFillerReport, model: string) {
  const occurrences = report.occurrences.filter(o => o.candidate.category === "ambiguous" && o.state !== "absorbed" && !o.previousGeneration);
  // A mesma palavra em duas cenas tem duas ações, mas uma só pergunta de contexto.
  const unique = new Map(occurrences.map(o => [o.candidate.id, o]));
  const items = [...unique.values()].map(({ candidate, unitText, prevText, nextText }) => ({ candidate, unitText, prevText, nextText }));
  const generation = createHash("sha256").update(JSON.stringify(occurrences.map(o => [
    o.sceneId, o.takeId, o.candidate.wordIds, o.candidate.start, o.candidate.end, fillerNoteKey(o, model),
  ]))).digest("hex");
  return { generation, items };
}

/** Dispara sem bloquear prévia/escritor. Falha e excedente ficam fechados na geração. */
export async function observeAssemblyFillers(dir: string, project: Project, deps: FillerObserveDeps): Promise<void> {
  const start = (starts.get(dir) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    // Um GET antigo não volta a geração para trás enquanto outro publica análise.
    const latest = await loadProject(dir).catch(() => project);
    await startObserve(dir, latest, deps);
  });
  starts.set(dir, start);
  await start;
  if (starts.get(dir) === start) starts.delete(dir);
}

async function startObserve(dir: string, project: Project, deps: FillerObserveDeps): Promise<void> {
  const { client, model } = observeConfig(deps);
  if (!model || !client || !project.scenes.length || project.preparation?.status === "running") {
    jobs.get(dir)?.controller.abort(); jobs.delete(dir); return;
  }
  const { generation, items } = generationItems(cachedFillerReport(dir, project).report, model);
  const current = jobs.get(dir);
  if (current?.generation === generation) return;
  current?.controller.abort();
  const cached = await readAssemblyFillerNotes(dir);
  // Outro snapshot pode ter ganhado enquanto a leitura estava em voo.
  const concurrent = jobs.get(dir);
  if (concurrent !== current && concurrent?.generation === generation) return;
  concurrent?.controller.abort();
  const job: Job = { generation, controller: new AbortController(), pending: cached?.generation !== generation && items.length > 0 };
  jobs.set(dir, job);
  if (!job.pending) return;
  void (async () => {
    try {
      const result = await scoreAmbiguous(client, items, { model, signal: job.controller.signal });
      if (jobs.get(dir) !== job || job.controller.signal.aborted) return;
      // Serializar só a publicação evita uma escrita antiga terminar depois da nova.
      const publication = (publications.get(dir) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (jobs.get(dir) !== job || job.controller.signal.aborted) return;
        const envelope: Envelope = { generation, ...result };
        await publishAtomic(join(dir, "fillers-notes.json"), `${JSON.stringify(envelope, null, 2)}\n`);
      });
      publications.set(dir, publication);
      await publication;
    } catch {
      // scoreAmbiguous persiste falhas do provedor; cancelamento não publica.
    } finally { job.pending = false; }
  })();
}

/** A classificação fica no cache; publicação de notas só muda a decoração. */
export async function assemblyFillerSnapshot(dir: string, project: Project, deps: FillerObserveDeps, snaps: FillerSnaps = {}, includeStale = false) {
  const base = cachedFillerReport(dir, project);
  await observeAssemblyFillers(dir, project, deps);
  const model = deps.decision?.model, envelope = await readAssemblyFillerNotes(dir);
  const generation = model ? generationItems(base.report, model) : undefined;
  const current = envelope?.generation === generation?.generation ? envelope : null;
  const validSnaps = currentFillerSnaps(project, snaps, base.report, base.index);
  const notes: FillerReportNotes = { model, notes: current?.notes, excess: current?.excess ?? (generation
    ? Math.max(0, generation.items.length - FILLER_JEV_MAX_PER_GENERATION) : 0),
    pending: jobs.get(dir)?.pending ?? false, snaps: includeStale ? snaps : validSnaps };
  const key = JSON.stringify(notes);
  if (base.decorated?.key !== key) base.decorated = { key, report: decorateFillerReport(project, base.report, notes, base.index) };
  return { report: base.decorated.report, snaps: validSnaps };
}

export async function assemblyFillerReport(dir: string, project: Project, deps: FillerObserveDeps, snaps?: FillerSnaps) {
  return (await assemblyFillerSnapshot(dir, project, deps, snaps)).report;
}
