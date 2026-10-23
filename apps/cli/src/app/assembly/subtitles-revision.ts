import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectAtSnapshot } from "./revisions.ts";
import { readHistorySnapshot } from "./store.ts";
import { parseVtt, subtitleRecord, type SubtitleRecord, type SubtitleResult } from "./subtitles.ts";
import type { Project } from "./types.ts";

export type RevisionSubtitles =
  | { ok: true; origem: "atual" | "entrega" | "historico"; legendas: SubtitleRecord; subtitles: SubtitleResult | null }
  | { ok: false; motivo: string };

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Legenda que a entrega da revisão gravou (`exports/<n>/legendas.*`), se os
 * arquivos ainda conferem com o manifest: é exatamente o texto entregue, e
 * a entrega só sai com a prévia daquela revisão.
 */
async function delivered(dir: string, revision: number): Promise<SubtitleResult | null> {
  const dest = join(dir, "exports", String(revision));
  try {
    const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as { revision?: unknown; legendas?: { status?: unknown; vttSha?: unknown; srtSha?: unknown } };
    if (manifest.revision !== revision || manifest.legendas?.status !== "pronto") return null;
    const [vtt, srt] = await Promise.all([readFile(join(dest, "legendas.vtt"), "utf8"), readFile(join(dest, "legendas.srt"), "utf8")]);
    if (sha(vtt) !== manifest.legendas.vttSha || sha(srt) !== manifest.legendas.srtSha) return null;
    return { cues: parseVtt(vtt), vtt, srt };
  } catch {
    return null;
  }
}

/**
 * Legenda de uma revisão para a prévia. A atual é a do próprio projeto, a
 * mesma que a exportação grava. Uma anterior vem, nesta ordem, da entrega
 * daquela revisão ou da foto `history/rev-<n>.json` recomposta, e a foto só
 * vale para a revisão da prévia guardada com a montagem exatamente igual à
 * que gerou o vídeo (`previewArtifact.assemblySha256`). Fora disso não há
 * legenda, e a da revisão atual nunca vai para cima de um vídeo antigo.
 */
export async function revisionSubtitles(dir: string, current: Project, revision: number): Promise<RevisionSubtitles> {
  if (revision === current.revision) return { ok: true, origem: "atual", ...subtitleRecord(current) };
  if (revision > current.revision) {
    return { ok: false, motivo: `a v${revision} ainda não existe (a montagem está na v${current.revision})` };
  }
  const entregue = await delivered(dir, revision);
  if (entregue) {
    return { ok: true, origem: "entrega", legendas: { status: "pronto", vttSha: sha(entregue.vtt), srtSha: sha(entregue.srt) }, subtitles: entregue };
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
  if (sha(JSON.stringify(past.assembly)) !== artifact.assemblySha256) {
    return { ok: false, motivo: `a montagem da v${revision} não pôde ser recomposta igual à da prévia` };
  }
  return { ok: true, origem: "historico", ...subtitleRecord(past) };
}
