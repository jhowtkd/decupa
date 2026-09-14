import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaInfo, Rate } from "./types.ts";

const run = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/** Preserva num/den. "0/0" e lixo viram null. */
export function parseRate(value: string | undefined): Rate | null {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  if (!Number.isInteger(num) || !Number.isInteger(den) || !num || !den) return null;
  return { num, den };
}

/** "25/1" -> 25 · "30000/1001" -> 29.97 */
function rateToFps(rate: Rate): number {
  return Math.round((rate.num / rate.den) * 100) / 100;
}

function isSane(rate: Rate | null): rate is Rate {
  if (!rate) return false;
  const fps = rate.num / rate.den;
  return Number.isFinite(fps) && fps > 0 && fps <= 120;
}

/** Prefere `r_frame_rate`; cai para `avg_frame_rate` se r ausente/absurdo. */
export function selectFrameRate(
  rFrameRate: string | undefined,
  avgFrameRate: string | undefined,
): Rate | null {
  const r = parseRate(rFrameRate);
  const avg = parseRate(avgFrameRate);
  if (isSane(r)) return r;
  if (isSane(avg)) return avg;
  return null;
}

export async function probe(path: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      path,
    ]));
  } catch (cause) {
    throw new Error(`ffprobe falhou em ${path}`, { cause });
  }

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const durationSeconds = Number(parsed.format?.duration ?? 0);

  const frameRate = selectFrameRate(video?.r_frame_rate, video?.avg_frame_rate);

  return {
    path,
    durationMs: Math.round(durationSeconds * 1000),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: frameRate ? rateToFps(frameRate) : null,
    frameRate,
    averageFrameRate: parseRate(video?.avg_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  };
}
