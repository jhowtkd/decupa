import { createHash } from "node:crypto";
import { projectAtSnapshot } from "./revisions.ts";
import { readHistorySnapshot } from "./store.ts";
import type { Project } from "./types.ts";

export type SubtitleSource =
  | { ok: true; project: Project; origem: "atual" | "historico" }
  | { ok: false; motivo: string };

/**
 * De que projeto sai a legenda de uma revisão. A atual é o próprio projeto,
 * o mesmo que a exportação usa. Uma revisão anterior só tem legenda quando é
 * a da prévia guardada: a foto `history/rev-<n>.json` é recomposta, e a
 * montagem recomposta tem de ser exatamente a que gerou o vídeo
 * (`previewArtifact.assemblySha256`). Fora disso não há legenda, e a da
 * revisão atual nunca vai para cima de um vídeo antigo.
 */
export async function subtitleSource(dir: string, current: Project, revision: number): Promise<SubtitleSource> {
  if (revision === current.revision) return { ok: true, project: current, origem: "atual" };
  if (revision > current.revision) {
    return { ok: false, motivo: `a v${revision} ainda não existe (a montagem está na v${current.revision})` };
  }
  const artifact = current.previewArtifact;
  if (!artifact || artifact.revision !== revision) {
    return { ok: false, motivo: `a v${revision} não é a prévia guardada; revisão anterior só tem legenda pela prévia` };
  }
  let past: Project;
  try {
    past = projectAtSnapshot(current, await readHistorySnapshot(dir, revision));
  } catch {
    return { ok: false, motivo: `a v${revision} não tem histórico para gerar a legenda da prévia` };
  }
  const sha = createHash("sha256").update(JSON.stringify(past.assembly)).digest("hex");
  if (sha !== artifact.assemblySha256) {
    return { ok: false, motivo: `a montagem da v${revision} não pôde ser recomposta igual à da prévia` };
  }
  return { ok: true, project: past, origem: "historico" };
}
