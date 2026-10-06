import type { Project } from "./types.ts";
import { createFillerIndex } from "./filler-index.ts";
import { fillerReport, type AssemblyFillerReport } from "./fillers.ts";

const reports = new Map<string, ReturnType<typeof build>>();

function build(project: Project, key: string) {
  const index = createFillerIndex(project);
  return { key, index, report: fillerReport(project, {}, { index }), decorated: undefined as { key: string; report: AssemblyFillerReport } | undefined };
}

/** Alinhamento pode publicar na mesma revisão; a chave inclui as dependências textuais. */
export function cachedFillerReport(dir: string, project: Project) {
  const key = JSON.stringify([project.revision, project.scenes, project.corrections, project.fillerExceptions,
    project.assembly.fps, project.assembly.sources.map(s => [s.id, s.sha256, s.path, s.hasAudio]),
    project.analyses.map(a => [a.sourceId, a.wordsStatus, a.words, a.speech])]);
  let cached = reports.get(dir);
  if (!cached || cached.key !== key) { cached = build(project, key); reports.set(dir, cached); }
  return cached;
}
