import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DEFAULT_SAMPLE_RATE = 16_000;

export function extractAudioArgs(opts: {
  input: string;
  output: string;
  sampleRate?: number;
  startSeconds?: number;
  durationSeconds?: number;
}): string[] {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const args = ["-v", "error", "-y", "-i", opts.input];
  // Seek de saída: -ss depois de -i. Seek de entrada (antes de -i) para em
  // keyframe e desloca o PCM que o snap/alinhamento trata como t=0.
  if (opts.startSeconds !== undefined) args.push("-ss", String(opts.startSeconds));
  if (opts.durationSeconds !== undefined) args.push("-t", String(opts.durationSeconds));
  args.push(
    "-vn",
    "-ar", String(sampleRate),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    opts.output,
  );
  return args;
}

export async function extractAudio(opts: {
  input: string;
  output: string;
  sampleRate?: number;
  startSeconds?: number;
  durationSeconds?: number;
}): Promise<void> {
  try {
    await run("ffmpeg", extractAudioArgs(opts));
  } catch (cause) {
    throw new Error(`extração de áudio falhou em ${opts.input}`, { cause });
  }
}

/**
 * Decodifica o áudio direto para memória como PCM s16le mono, sem arquivo
 * intermediário. `maxBuffer` alto porque 1 h a 16 kHz são ~115 MB.
 */
export async function readPcm(opts: {
  input: string;
  sampleRate?: number;
}): Promise<Int16Array> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  let stdout: Buffer;
  try {
    ({ stdout } = await run("ffmpeg", [
      "-v", "error",
      "-i", opts.input,
      "-vn",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-",
    ], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }));
  } catch (cause) {
    throw new Error(`leitura de PCM falhou em ${opts.input}`, { cause });
  }

  // Descarta um byte ímpar residual, se houver, para não quebrar o Int16Array.
  const usableBytes = stdout.byteLength - (stdout.byteLength % 2);
  return new Int16Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + usableBytes),
  );
}
