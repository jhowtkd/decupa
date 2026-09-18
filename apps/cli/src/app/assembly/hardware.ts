import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { probe } from "@decupa/media";
import type { Executor } from "../pipeline.ts";

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
  args: string[],
): Promise<boolean> {
  const result = await exec.run({
    command: "ffmpeg",
    args: ["-y", "-i", input, "-t", "2", ...args, output],
  });
  if (result.code !== 0) return false;
  const info = await probe(output).catch(() => null);
  return Boolean(info?.hasVideo && (info.durationMs ?? 0) > 0);
}

export async function proveHardwareEncode(
  input: string,
  outDir: string,
  exec: Executor,
): Promise<HardwareProof> {
  await mkdir(outDir, { recursive: true });
  const encoders = await listEncoders(exec);
  const attempted: HardwareProfile[] = [];
  const listed = new Set(encoders);
  for (const candidate of HW_ENCODERS) {
    if (!listed.has(candidate.encoder)) continue;
    attempted.push(candidate.profile);
    const output = join(outDir, `hw-${candidate.profile}.mp4`);
    const hwArgs = [
      ...(candidate.hwaccel ? ["-hwaccel", candidate.hwaccel] : []),
      "-c:v", candidate.encoder,
      "-pix_fmt", "yuv420p",
      "-an",
    ];
    const ok = await encode(exec, input, output, hwArgs);
    if (ok) {
      return {
        profile: candidate.profile,
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
  const ok = await encode(exec, input, output, ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]);
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
