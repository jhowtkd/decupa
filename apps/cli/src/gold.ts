import { writeFile } from "node:fs/promises";
import { totalDurationMs, type Interval } from "@decupa/core";
import { alignEditedFiles } from "@decupa/goldedit";
import { probe } from "@decupa/media";

// Um quadro a 30 fps, como no critério G0 de scripts/segment-timing.test.ts.
const DURATION_TOLERANCE_MS = 1000 / 30;

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
  const removedMs = totalDurationMs(removed);
  const durationDifferenceMs = Math.abs(
    rawInfo.durationMs - editedInfo.durationMs - removedMs,
  );
  if (!Number.isFinite(durationDifferenceMs) || durationDifferenceMs > DURATION_TOLERANCE_MS) {
    throw new Error(
      `alinhamento inconclusivo: bruto (${rawInfo.durationMs} ms) − ` +
      `editado (${editedInfo.durationMs} ms) − removido (${removedMs} ms) ` +
      `difere ${durationDifferenceMs} ms (tolerância ${DURATION_TOLERANCE_MS} ms); ` +
      "revise o par bruto/editado antes de publicar o gold",
    );
  }

  const result: GoldEditFile = {
    raw: opts.rawPath,
    edited: opts.editedPath,
    rawDurationMs: rawInfo.durationMs,
    editedDurationMs: editedInfo.durationMs,
    removedMs,
    removed,
    generatedAt: new Date().toISOString(),
  };

  await writeFile(opts.outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
