import { writeFile } from "node:fs/promises";
import { totalDurationMs, type Interval } from "@decupa/core";
import { alignEditedFiles } from "@decupa/goldedit";
import { probe } from "@decupa/media";

export interface GoldEditFile {
  raw: string;
  edited: string;
  rawDurationMs: number;
  editedDurationMs: number;
  removedMs: number;
  removed: Interval[];
  generatedAt: string;
}

/**
 * Deriva os cortes de um par bruto/editado e grava o gold edit em JSON.
 * É assim que o trabalho já feito pelo time vira dataset anotado.
 */
export async function runGold(opts: {
  rawPath: string;
  editedPath: string;
  outPath: string;
}): Promise<GoldEditFile> {
  const [rawInfo, editedInfo] = await Promise.all([
    probe(opts.rawPath),
    probe(opts.editedPath),
  ]);

  if (editedInfo.durationMs > rawInfo.durationMs) {
    throw new Error(
      `o editado (${editedInfo.durationMs} ms) é mais longo que o bruto ` +
      `(${rawInfo.durationMs} ms) — os argumentos parecem trocados`,
    );
  }

  const removed = await alignEditedFiles({
    rawPath: opts.rawPath,
    editedPath: opts.editedPath,
  });

  const result: GoldEditFile = {
    raw: opts.rawPath,
    edited: opts.editedPath,
    rawDurationMs: rawInfo.durationMs,
    editedDurationMs: editedInfo.durationMs,
    removedMs: totalDurationMs(removed),
    removed,
    generatedAt: new Date().toISOString(),
  };

  await writeFile(opts.outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
