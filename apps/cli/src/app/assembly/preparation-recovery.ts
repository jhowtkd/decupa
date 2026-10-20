import { isPreparationActive } from "./preparation.ts";
import { loadProject, saveProject } from "./store.ts";
import type { Project } from "./types.ts";

/** Mesmo reparo para o GET do editor e para o Hub, sem iniciar preparação. */
export async function recoverInterruptedPreparation(dir: string, project: Project): Promise<Project> {
  if (project.preparation?.status !== "running" || isPreparationActive(dir)) return project;
  try {
    await saveProject(dir, project.revision, current => {
      if (current.preparation?.status !== "running" || isPreparationActive(dir)) return current;
      return { ...current, preparation: { ...current.preparation, status: "interrupted",
        error: "preparação interrompida: servidor reiniciado; clique em Retomar" } };
    });
    return await loadProject(dir);
  } catch {
    // Conflito de escrita não autoriza mostrar execução sem processo vivo.
    const latest = await loadProject(dir).catch(() => project);
    if (latest.preparation?.status === "running" && !isPreparationActive(dir)) {
      return { ...latest, preparation: { ...latest.preparation, status: "interrupted",
        error: "preparação interrompida: servidor reiniciado; clique em Retomar" } };
    }
    return latest;
  }
}
