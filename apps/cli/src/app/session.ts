import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
    // O índice existe (o ingest acabou de gravá-lo); vazio quer dizer que a
    // transcrição não trouxe fala que o motor aproveite.
    throw new Error(
      "nenhuma unidade de fala para cortar: a transcrição deste vídeo não trouxe fala que o motor " +
      "aproveite. Confira se o áudio tem voz em português.",
    );
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

/** Identidade barata da fonte: sem hash do arquivo, porque vídeo tem dezenas de GB. */
export interface SourceManifest {
  path: string;
  size: number;
  mtimeMs: number;
  /**
   * sha256 de `tamanho + primeiro MiB + último MiB`. Desempata "só o mtime
   * mudou": cópia, sincronização de nuvem, `touch` e antivírus mexem na data
   * sem mexer no conteúdo. Manifesto antigo não tem: então a data decide.
   */
  sample?: string;
}

const SAMPLE_BYTES = 1024 * 1024;

/**
 * Amostra barata do conteúdo: 2 MiB lidos, seja qual for o tamanho do vídeo.
 * Não prova que o meio é igual; pega troca de arquivo, que muda cabeçalho e
 * final (moov, timecode, duração), e regravação com outro tamanho.
 */
export async function sourceSample(path: string, size: number): Promise<string> {
  const hash = createHash("sha256").update(String(size));
  const handle = await open(path, "r");
  try {
    const length = Math.min(SAMPLE_BYTES, size);
    const buffer = Buffer.alloc(length);
    for (const position of [0, Math.max(0, size - length)]) {
      // Uma leitura só pode voltar curta (sistema de rede ou sob demanda) e
      // daria uma amostra diferente a cada vez: lê até completar o trecho ou
      // até o fim do arquivo.
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      hash.update(buffer.subarray(0, filled));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export const sourceManifestPath = (workDir: string) => join(workDir, "source.json");

async function readManifest(workDir: string): Promise<SourceManifest | null> {
  try {
    return JSON.parse(await readFile(sourceManifestPath(workDir), "utf8")) as SourceManifest;
  } catch {
    return null;
  }
}

/**
 * Grava o manifesto por parcial e rename: ele decide o que é reusado. O nome
 * do parcial é único por gravação: duas requisições simultâneas depois de uma
 * mudança só de mtime disputavam o mesmo arquivo, e uma perdia o rename.
 */
async function writeManifest(workDir: string, manifest: SourceManifest): Promise<void> {
  const partial = `${sourceManifestPath(workDir)}.${process.pid}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, `${JSON.stringify(manifest)}\n`, "utf8");
    await rename(partial, sourceManifestPath(workDir));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * A fonte é a mesma do manifesto? Caminho e tamanho iguais e mtime igual:
 * sim. Só o mtime diferente: compara a amostra e, se ela bate, segue (o vídeo
 * não mudou) e tenta regravar o manifesto com a data nova, em melhor esforço:
 * um manifesto não regravado só custa outra leitura de 2 MiB na próxima vez.
 * Amostra diferente, ausente (manifesto antigo) ou ilegível: não.
 */
async function sourceUnchanged(
  workDir: string,
  saved: SourceManifest | null,
  current: SourceManifest,
): Promise<boolean> {
  if (!saved || saved.path !== current.path || saved.size !== current.size) return false;
  if (saved.mtimeMs === current.mtimeMs) return true;
  if (!saved.sample) return false;
  const sample = await sourceSample(current.path, current.size).catch(() => null);
  if (sample !== saved.sample) return false;
  await writeManifest(workDir, { ...current, sample }).catch(() => undefined);
  return true;
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
  if (await sourceUnchanged(workDir, saved, current)) return {};

  let staleDir: string | undefined;
  const entries = await readdir(workDir).catch(() => []);
  if (entries.length > 0) {
    staleDir = await freeStaleName(workDir, now());
    await rename(workDir, staleDir);
  }
  await mkdir(workDir, { recursive: true });
  const sample = await sourceSample(input, source.size).catch(() => undefined);
  await writeManifest(workDir, sample ? { ...current, sample } : current);
  return staleDir ? { staleDir } : {};
}

/**
 * Confere de novo a fonte contra o manifesto da pasta, antes de gerar um
 * derivado (proxy de triagem, export). A subida confere uma vez; trocar o
 * vídeo com o app aberto misturaria o corte do vídeo antigo com a mídia nova.
 * Devolve a mensagem para quem pediu, ou `null` se a fonte é a mesma.
 */
export async function sourceMismatch(workDir: string, input: string): Promise<string | null> {
  const source = await stat(input).catch(() => null);
  if (!source) {
    return `não consegui ler o vídeo em ${input}: ele foi movido ou apagado depois que o app abriu. ` +
      "Nada foi gerado. Feche e abra o app de novo.";
  }
  const saved = await readManifest(workDir);
  // A mesma função da subida: só o mtime mudado não é troca de vídeo.
  if (await sourceUnchanged(workDir, saved, { path: input, size: source.size, mtimeMs: source.mtimeMs })) return null;
  return `o vídeo ${basename(input)} mudou depois que o app abriu (tamanho ou data diferentes do que ` +
    "foi transcrito). Nada foi gerado. Feche e abra o app de novo para transcrever a versão nova.";
}
