import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Uma linha, no mesmo formato que o `--keep` do motor consome. */
export const keepPath = (workDir: string) => join(workDir, "keep.txt");

/**
 * O keep-list é a única parte do trabalho que a máquina não refaz. Transcrição
 * e índice ficam em cache no workDir; o julgamento de quem leu a prosa some com
 * o processo. Gravar a string a cada replan custa um write e devolve a sessão
 * inteira ao reabrir o mesmo vídeo.
 */
export async function readKeepList(workDir: string): Promise<string | null> {
  const raw = await readFile(keepPath(workDir), "utf8").catch(() => null);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function writeKeepList(workDir: string, keepList: string): Promise<void> {
  await writeFile(keepPath(workDir), `${keepList.trim()}\n`, "utf8");
}

/** O keep-list com que o job começa: a sessão gravada, ou o vídeo inteiro. */
export function initialKeepList(saved: string | null, unitIds: string[]): string {
  if (saved !== null) return saved;
  if (unitIds.length === 0) {
    throw new Error("índice sem unidade nenhuma — rode `condense.py index` antes");
  }
  return `${unitIds[0]}-${unitIds[unitIds.length - 1]}`;
}
