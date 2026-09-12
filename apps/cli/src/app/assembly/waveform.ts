import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Executor } from "../pipeline.ts";

/** Taxa do PCM intermediário: suficiente para a faixa, barato de agregar. */
export const PEAKS_SAMPLE_RATE = 8000;

export type PeaksBucket = { min: number; max: number };

export type PeaksFile = {
  version: 1;
  sha256: string;
  sampleRate: number;
  buckets: number;
  /** Amostras s16le agregadas. */
  count: number;
  peaks: PeaksBucket[];
};

export type BuildPeaksOpts = {
  proxyPath: string;
  sha256: string;
  outPath: string;
  buckets?: number;
  durationSeconds?: number;
};

/**
 * Cache dos peaks ao lado do proxy, um arquivo por hash: trocar a fonte
 * invalida sozinho, sem versão extra.
 */
export function peaksPath(dir: string, sha256: string): string {
  return join(dir, "media", sha256, `${sha256}.peaks.json`);
}

/**
 * Agrega o áudio do proxy em min/max por bucket e grava o JSON em outPath.
 * Best-effort: TODA falha (ffmpeg, leitura, escrita) vira `null` — nunca
 * derruba a etapa media nem bloqueia transcrição/proposta/prévia.
 */
export async function buildPeaks(
  exec: Executor,
  opts: BuildPeaksOpts,
): Promise<{ path: string; buckets: number; count: number } | null> {
  try {
    const defaultBuckets = opts.durationSeconds
      ? Math.max(500, Math.min(20_000, Math.round(opts.durationSeconds * 25)))
      : 1000;
    const buckets = opts.buckets ?? defaultBuckets;
    if (!Number.isSafeInteger(buckets) || buckets <= 0) return null;
    if (!opts.proxyPath || !opts.sha256 || !opts.outPath) return null;
    // PCM cru num temporário (o Executor só devolve texto em stdout):
    // o fake de teste grava bytes determinísticos no último arg.
    // O diretório nasce aqui: nem o ffmpeg real cria pai ausente.
    await mkdir(dirname(opts.outPath), { recursive: true });
    const tmp = `${opts.outPath}.${process.pid}.tmp.pcm`;
    const result = await exec.run({
      command: "ffmpeg",
      args: [
        "-v", "error", "-y", "-i", opts.proxyPath,
        "-vn", "-ar", String(PEAKS_SAMPLE_RATE), "-ac", "1",
        "-c:a", "pcm_s16le", "-f", "s16le", tmp,
      ],
    });
    if (result.code !== 0) {
      await unlink(tmp).catch(() => undefined);
      return null;
    }
    let raw: Buffer;
    try {
      raw = await readFile(tmp);
    } catch {
      return null;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    const count = Math.floor(raw.length / 2);
    if (count === 0) return null;
    const usable = raw.length - (raw.length % 2);
    const samples = new Int16Array(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + usable),
    );
    const per = count / buckets;
    const peaks: PeaksBucket[] = [];
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(count, Math.max(start + 1, Math.floor((b + 1) * per)));
      let min = 32767;
      let max = -32768;
      for (let i = start; i < end; i++) {
        const value = samples[i]!;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      peaks.push({ min, max });
    }
    const file: PeaksFile = {
      version: 1,
      sha256: opts.sha256,
      sampleRate: PEAKS_SAMPLE_RATE,
      buckets,
      count,
      peaks,
    };
    await writeFile(opts.outPath, `${JSON.stringify(file)}\n`, "utf8");
    return { path: opts.outPath, buckets, count };
  } catch {
    return null;
  }
}
