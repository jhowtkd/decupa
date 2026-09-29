import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

/**
 * Pasta de trabalho da limpeza, ao lado do vídeo. O nome leva a extensão:
 * `aula.mov` e `aula.mp4` não dividem transcrição. Pastas antigas
 * `.decupa-<nome sem extensão>` ficam onde estão, nunca lidas nem apagadas.
 */
export function cleanupWorkDir(input: string): string {
  return join(dirname(input), `.decupa-${basename(input)}`);
}

/** Identidade barata da fonte: sem hash, porque vídeo tem dezenas de GB. */
export interface SourceManifest {
  path: string;
  size: number;
  mtimeMs: number;
}

export const sourceManifestPath = (workDir: string) => join(workDir, "source.json");

async function readManifest(workDir: string): Promise<SourceManifest | null> {
  try {
    return JSON.parse(await readFile(sourceManifestPath(workDir), "utf8")) as SourceManifest;
  } catch {
    return null;
  }
}

async function freeStaleName(workDir: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  for (let n = 1; ; n += 1) {
    const candidate = `${workDir}.stale-${stamp}${n > 1 ? `-${n}` : ""}`;
    const taken = await lstat(candidate).then(() => true, () => false);
    if (!taken) return candidate;
  }
}

/**
 * Amarra a pasta de trabalho ao conteúdo da fonte antes de qualquer reuso.
 * Transcrição, índice, proxies, keep.txt e cache de triagem são reusados só
 * porque existem; trocar o vídeo mantendo o nome serviria o corte do outro.
 *
 * Com conteúdo na pasta e manifesto ausente ou diferente do stat atual, a
 * pasta inteira vai para `<pasta>.stale-<timestamp>` — rename, nunca apagar:
 * ela pode ter exports do usuário. Fonte ilegível não mexe em nada; o
 * preflight é quem diz que o vídeo sumiu.
 */
export async function claimWorkDir(
  workDir: string,
  input: string,
  now: () => number = Date.now,
): Promise<{ staleDir?: string }> {
  const source = await stat(input).catch(() => null);
  if (!source) return {};
  const current: SourceManifest = { path: input, size: source.size, mtimeMs: source.mtimeMs };
  const saved = await readManifest(workDir);
  if (
    saved?.path === current.path
    && saved.size === current.size
    && saved.mtimeMs === current.mtimeMs
  ) return {};

  let staleDir: string | undefined;
  const entries = await readdir(workDir).catch(() => []);
  if (entries.length > 0) {
    staleDir = await freeStaleName(workDir, now());
    await rename(workDir, staleDir);
  }
  await mkdir(workDir, { recursive: true });
  await writeFile(sourceManifestPath(workDir), `${JSON.stringify(current)}\n`, "utf8");
  return staleDir ? { staleDir } : {};
}
