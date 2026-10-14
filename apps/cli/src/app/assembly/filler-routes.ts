import type { Project } from "./types.ts";
import { fillerReport, type FillerTarget } from "./fillers.ts";
import { loadProject, saveProject, writeHistorySnapshot } from "./store.ts";
import { recordUndo } from "./undo.ts";

export function parseFillerTargets(raw: unknown, project: Project): FillerTarget[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10000) throw Error("targets precisa conter ocorrências");
  const occurrences = new Set(fillerReport(project).occurrences.filter(o => o.state !== "absorbed").map(o => JSON.stringify([o.candidateId, o.sceneId, o.takeId])));
  const seen = new Set<string>();
  return raw.map(entry => {
    if (!entry || typeof entry !== "object") throw Error("ocorrência de cacoete inválida");
    const { candidateId, sceneId, takeId } = entry;
    if (![candidateId, sceneId, takeId].every(v => typeof v === "string" && v.length > 0)) throw Error("ocorrência de cacoete inválida");
    const target = { candidateId, sceneId, takeId } as FillerTarget;
    const key = JSON.stringify(target);
    if (seen.has(key) || !occurrences.has(JSON.stringify([candidateId, sceneId, takeId]))) throw Error("ocorrência ausente ou duplicada");
    seen.add(key); return target;
  });
}

/** A leitura acústica já terminou; o callback do escritor continua síncrono. */
export async function commitFillerChange(dir: string, revision: number, change: (project: Project) => Project, label: string): Promise<Project> {
  const before = await loadProject(dir);
  if (before.revision !== revision) throw Error("revisão desatualizada");
  await writeHistorySnapshot(dir, before);
  await saveProject(dir, revision, current => {
    if (current.revision !== revision) throw Error("revisão desatualizada");
    const next = change(current);
    return next === current ? current : recordUndo(current, next, label);
  });
  return loadProject(dir);
}
