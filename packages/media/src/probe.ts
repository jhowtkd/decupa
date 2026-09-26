import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaInfo, Rate } from "./types.ts";

const run = promisify(execFile);

interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number | string;
  displaymatrix?: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  tags?: Record<string, string | undefined>;
  side_data_list?: FfprobeSideData[];
}

interface FfprobeOutput {
  format?: { duration?: string; tags?: Record<string, string | undefined> };
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

/**
 * Etiqueta de timecode gravada na mídia: tag do stream de vídeo
 * (`-timecode` do ffmpeg), depois a de qualquer outro stream (a trilha `tmcd`
 * que MOV de câmera/celular carrega à parte) e por fim a tag do container.
 * Lixo/"" viram null — a exportação decide se o valor é legível.
 */
export function readTimecode(
  video: FfprobeStream | undefined,
  formatTags: Record<string, string | undefined> | undefined,
  streams: FfprobeStream[] = [],
): string | null {
  const raw = video?.tags?.timecode
    ?? streams.find((stream) => stream.tags?.timecode)?.tags?.timecode
    ?? formatTags?.timecode;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Rotação de exibição em graus: `side_data_list` (Display Matrix,
 * `rotation` vira negativo no ffmpeg ≥5) ou a tag legada `rotate`.
 * Valores que não são múltiplos de 90 viram null — meia-rotação
 * arbitrária não muda o formato da entrega.
 */
export function readRotation(video: FfprobeStream | undefined): number | null {
  const side = video?.side_data_list?.find(
    (item) => item.rotation !== undefined || item.displaymatrix !== undefined,
  );
  const raw = side?.rotation ?? video?.tags?.rotate;
  const degrees = Number(raw);
  if (!Number.isFinite(degrees)) return null;
  const normalized = ((Math.round(degrees) % 360) + 360) % 360;
  return normalized % 90 === 0 ? normalized : null;
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
    timecode: readTimecode(video, parsed.format?.tags, streams),
    rotation: readRotation(video),
  };
}
