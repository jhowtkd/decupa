import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Interval } from "@decupa/core";

const run = promisify(execFile);

/**
 * O `silencedetect` do ffmpeg escreve em stderr, uma linha por evento:
 *   [silencedetect @ 0x...] silence_start: 1
 *   [silencedetect @ 0x...] silence_end: 1.600062 | silence_duration: 0.600063
 */
const START_RE = /silence_start:\s*(-?[\d.]+)/g;
const END_RE = /silence_end:\s*(-?[\d.]+)/g;

export async function detectSilence(opts: {
  input: string;
  thresholdDb?: number;
  minDurationMs?: number;
}): Promise<Interval[]> {
  const thresholdDb = opts.thresholdDb ?? -35;
  const minDurationMs = opts.minDurationMs ?? 300;
  const filter = `silencedetect=noise=${thresholdDb}dB:d=${minDurationMs / 1000}`;

  // ffmpeg sai com código 0 aqui, mas o log vai para stderr mesmo em -v info.
  const { stderr } = await run("ffmpeg", [
    "-v", "info",
    "-i", opts.input,
    "-af", filter,
    "-f", "null", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });

  const starts = [...stderr.matchAll(START_RE)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(END_RE)].map((m) => Number(m[1]));

  const intervals: Interval[] = [];
  for (let i = 0; i < starts.length; i++) {
    const startSeconds = Math.max(0, starts[i]!);
    // Silêncio que vai até o fim do arquivo não gera silence_end: descarta,
    // porque não é um corte candidato — é só o rabo da gravação.
    const endSeconds = ends[i];
    if (endSeconds === undefined) continue;
    intervals.push({
      startMs: Math.round(startSeconds * 1000),
      endMs: Math.round(endSeconds * 1000),
    });
  }

  return intervals;
}
