import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probe } from "@decupa/media";
import { isCancelledError } from "@decupa/queue";
import type { Executor } from "../pipeline.ts";
import { mediaWork } from "./media-work.ts";

export type HardwareProfile = "software" | "videotoolbox" | "nvenc" | "vaapi";

export type HardwareProof = {
  profile: HardwareProfile;
  fallback: boolean;
  output: string;
  encoders: string[];
  attempted: HardwareProfile[];
  compared: {
    width: number | null;
    height: number | null;
    durationMs: number;
    orientation: "landscape" | "portrait" | "square";
    color: string;
    syncMs: number;
    cutPrecisionMs: number;
  };
};

const HW_ENCODERS: { profile: HardwareProfile; encoder: string; hwaccel?: string }[] = [
  { profile: "videotoolbox", encoder: "h264_videotoolbox", hwaccel: "videotoolbox" },
  { profile: "nvenc", encoder: "h264_nvenc" },
  { profile: "vaapi", encoder: "h264_vaapi", hwaccel: "vaapi" },
];

// Perfis que a detecção pode declarar ativos: somente os implementados pelo
// motor neste caminho. vaapi segue mapeado em encoderFor, mas nunca é
// anunciado porque o motor não faz o setup de device que ele exige.
const DETECT_ORDER: HardwareProfile[] = ["videotoolbox", "nvenc"];

const PROFILES = new Set<HardwareProfile>(["software", "videotoolbox", "nvenc", "vaapi"]);

export function encoderFor(profile: HardwareProfile): { encoder: string; hwaccel?: string } {
  const found = HW_ENCODERS.find((candidate) => candidate.profile === profile);
  if (found) return { encoder: found.encoder, hwaccel: found.hwaccel };
  return { encoder: "libx264" };
}

/** Opções de entrada: -hwaccel é opção de entrada e vai antes de -i. */
function inputArgs(profile: HardwareProfile): string[] {
  const { hwaccel } = encoderFor(profile);
  return [
    ...(hwaccel ? ["-hwaccel", hwaccel] : []),
    "-threads", "2",
  ];
}

/** Opções de saída da prova: 640px preservando proporção, software limitado. */
function outputArgs(profile: HardwareProfile): string[] {
  const { encoder } = encoderFor(profile);
  const video = encoder === "libx264"
    ? ["-c:v", encoder, "-preset", "veryfast", "-crf", "20"]
    : ["-c:v", encoder, "-b:v", "8M", ...(encoder === "h264_videotoolbox" ? ["-allow_sw", "0"] : [])];
  return [
    "-vf", "scale=640:-2",
    "-filter_threads", "1",
    ...video,
    "-threads", "2",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
  ];
}

const REQUESTED_CUT_MS = 2000;

export async function listEncoders(exec: Executor): Promise<string[]> {
  const result = await exec.run({ command: "ffmpeg", args: ["-hide_banner", "-encoders"] });
  const text = `${result.stdout}\n${result.stderr}`;
  return [...text.matchAll(/^\s*[\w.]+\s+(h264_[a-z0-9]+)/gm)].map((m) => m[1]!);
}

function orientation(width: number | null, height: number | null): HardwareProof["compared"]["orientation"] {
  if (!width || !height) return "square";
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}

async function ffprobeField(
  exec: Executor,
  path: string,
  args: string[],
): Promise<string> {
  const result = await exec.run({ command: "ffprobe", args: ["-v", "error", ...args, path] });
  return `${result.stdout}\n${result.stderr}`.trim();
}

async function streamDurationMs(
  exec: Executor,
  path: string,
  stream: "v:0" | "a:0",
): Promise<number | null> {
  const raw = await ffprobeField(exec, path, [
    "-select_streams", stream,
    "-show_entries", "stream=duration",
    "-of", "csv=p=0",
  ]);
  const seconds = Number(raw.split(/\s+/)[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

async function compareOutput(
  exec: Executor,
  path: string,
  requestedMs: number,
): Promise<HardwareProof["compared"]> {
  const info = await probe(path);
  const color = (await ffprobeField(exec, path, [
    "-select_streams", "v:0",
    "-show_entries", "stream=pix_fmt",
    "-of", "csv=p=0",
  ])).split(/\s+/)[0] || "unknown";
  const videoMs = await streamDurationMs(exec, path, "v:0") ?? info.durationMs;
  const audioMs = await streamDurationMs(exec, path, "a:0");
  return {
    width: info.width,
    height: info.height,
    durationMs: info.durationMs,
    orientation: orientation(info.width, info.height),
    color,
    syncMs: audioMs == null ? 0 : Math.abs(videoMs - audioMs),
    cutPrecisionMs: Math.abs(videoMs - requestedMs),
  };
}

async function encode(
  exec: Executor,
  input: string,
  output: string,
  profile: HardwareProfile,
  signal?: AbortSignal,
): Promise<boolean> {
  return mediaWork.run(async () => {
    signal?.throwIfAborted();
    const result = await exec.run({
      command: "ffmpeg",
      args: [
        "-y",
        ...inputArgs(profile),
        "-i", input,
        "-t", "2",
        ...outputArgs(profile),
        output,
      ],
      signal,
    });
    if (result.code !== 0) {
      await unlink(output).catch(() => {});
      return false;
    }
    const info = await probe(output).catch(() => null);
    // Prova de vídeo: exige stream de vídeo e duração, nunca áudio — clipe
    // silencioso válido não pode reprovar o encoder.
    const ok = Boolean(info?.hasVideo && (info.durationMs ?? 0) > 0);
    if (!ok) await unlink(output).catch(() => {});
    return ok;
    // Sinal também na espera da fila: cancelar a preparação não pode deixar a
    // prova parada na mediaWork segurando quem veio depois.
  }, { key: output, signal });
}

export async function proveHardwareEncode(
  input: string,
  outDir: string,
  exec: Executor,
  opts: { signal?: AbortSignal } = {},
): Promise<HardwareProof> {
  await mkdir(outDir, { recursive: true });
  const encoders = await listEncoders(exec);
  const attempted: HardwareProfile[] = [];
  const listed = new Set(encoders);
  for (const profile of DETECT_ORDER) {
    const { encoder } = encoderFor(profile);
    if (!listed.has(encoder)) continue;
    attempted.push(profile);
    const output = join(outDir, `hw-${profile}.mp4`);
    const ok = await encode(exec, input, output, profile, opts.signal);
    if (ok) {
      return {
        profile,
        fallback: false,
        output,
        encoders,
        attempted,
        compared: await compareOutput(exec, output, REQUESTED_CUT_MS),
      };
    }
  }

  attempted.push("software");
  const output = join(outDir, "hw-software.mp4");
  const ok = await encode(exec, input, output, "software", opts.signal);
  if (!ok) throw new Error("encode de software falhou na fixture real");
  return {
    profile: "software",
    fallback: true,
    output,
    encoders,
    attempted,
    compared: await compareOutput(exec, output, REQUESTED_CUT_MS),
  };
}

const PROFILE_CACHE_VERSION = 2;

export async function detectHardwareProfile(
  input: string,
  outDir: string,
  exec: Executor,
  opts: { signal?: AbortSignal } = {},
): Promise<HardwareProfile> {
  const cachePath = join(outDir, "profile.json");
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as { profile?: unknown; version?: unknown };
    // Cache antigo (sem versão) não serve: a prova mudou de posição de
    // -hwaccel, escala e critério de áudio.
    if (
      cached.version === PROFILE_CACHE_VERSION
      && typeof cached.profile === "string"
      && PROFILES.has(cached.profile as HardwareProfile)
    ) {
      return cached.profile as HardwareProfile;
    }
  } catch {
    // First detection for this project directory.
  }
  let profile: HardwareProfile = "software";
  try {
    profile = (await proveHardwareEncode(input, outDir, exec, opts)).profile;
  } catch (err) {
    // Falha de prova cai para software; cancelamento propaga — trabalho
    // cancelado não pode seguir para o render nem poluir o cache.
    if (isCancelledError(err)) throw err;
    profile = "software";
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({ profile, version: PROFILE_CACHE_VERSION })}\n`);
  return profile;
}
