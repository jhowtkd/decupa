import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const GENERATED = join(dirname(fileURLToPath(import.meta.url)), "generated");
const pending = new Map<string, Promise<string>>();

function fpsToken(fps: number): string {
  if (Number.isInteger(fps)) return String(fps);
  return fps.toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(".", "p");
}

/**
 * MP4 com exatamente `frames` quadros a `fps` (vídeo + AAC).
 * Cache em tests/fixtures/generated/, gravado em temporário e renomeado:
 * os workers do vitest geram o mesmo arquivo em paralelo.
 */
export function exactReferenceMp4(frames: number, fps: number): Promise<string> {
  if (!Number.isInteger(frames) || frames <= 0) {
    return Promise.reject(new Error(`quadros inválidos: ${frames}`));
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    return Promise.reject(new Error(`fps inválido: ${fps}`));
  }
  const key = `${frames}@${fpsToken(fps)}`;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const job = writeExact(frames, fps, key).catch((err: unknown) => {
    pending.delete(key);
    throw err;
  });
  pending.set(key, job);
  return job;
}

async function writeExact(frames: number, fps: number, key: string): Promise<string> {
  await mkdir(GENERATED, { recursive: true });
  const [frameToken, rateToken] = key.split("@");
  const dest = join(GENERATED, `ref-${frameToken}f-${rateToken}fps.mp4`);
  if (await stat(dest).then((info) => info.size > 0, () => false)) return dest;
  const tmp = join(
    GENERATED,
    `.ref-${frameToken}f-${rateToken}-${process.pid}-${randomBytes(4).toString("hex")}.tmp.mp4`,
  );
  const seconds = (frames / fps).toFixed(6);
  const rate = Number.isInteger(fps) ? String(fps) : fps.toFixed(6);
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-y",
      "-f", "lavfi", "-i", `testsrc=size=320x240:rate=${rate}:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-frames:v", String(frames),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      "-movflags", "+faststart",
      tmp,
    ]);
    try {
      await rename(tmp, dest);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      const raced = err as NodeJS.ErrnoException;
      if (raced.code !== "EEXIST" || !(await stat(dest).then((info) => info.size > 0, () => false))) {
        throw err;
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return dest;
}

type EngineClip = { timeline_start?: number; start?: number; end?: number };
type EngineDoc = {
  output_canvas?: { fps?: number };
  project?: { fps?: number };
  tracks?: { clips?: EngineClip[] }[];
};

/** Duração da timeline do motor: max(timeline_start + end − start), em quadros. */
export function spanFromEngineTimeline(doc: unknown): { frames: number; fps: number } {
  if (typeof doc !== "object" || doc === null) throw new Error("timeline inválida");
  const root = doc as EngineDoc;
  const fps = root.output_canvas?.fps ?? root.project?.fps;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    throw new Error("timeline sem fps");
  }
  let end = 0;
  for (const track of root.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const at = clip.timeline_start ?? 0;
      const span = (clip.end ?? 0) - (clip.start ?? 0);
      end = Math.max(end, at + span);
    }
  }
  return { frames: Math.max(0, Math.round(end * fps)), fps };
}

/**
 * Se a chamada é um render (`--timeline`), grava reference.mp4 com a duração
 * da timeline. Timeline vazia não ganha o clipe de 3 s. Sem `--timeline`,
 * devolve false e o chamador mantém o comportamento anterior.
 */
export async function writeTimelineReference(call: {
  args: readonly string[];
  cwd?: string;
  env?: { CLAUDE_PROJECT_DIR?: string };
}): Promise<boolean> {
  const timelineAt = call.args.indexOf("--timeline");
  if (timelineAt < 0) return false;
  const timelinePath = call.args[timelineAt + 1];
  if (!timelinePath) return false;
  const { frames, fps } = spanFromEngineTimeline(JSON.parse(await readFile(timelinePath, "utf8")));
  if (frames <= 0) return false;
  const outAt = call.args.indexOf("--out");
  const dest = outAt >= 0 && call.args[outAt + 1]
    ? call.args[outAt + 1]!
    : join(call.env?.CLAUDE_PROJECT_DIR || call.cwd || "", "reference.mp4");
  await copyFile(await exactReferenceMp4(frames, fps), dest);
  return true;
}

/**
 * MP4 minúsculo (16×16, sem áudio) com duração de container igual a `seconds`.
 * Serve de proxy longo: o encode stillimage não cresce com a duração.
 */
export function stillDurationMp4(seconds: number): Promise<string> {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return Promise.reject(new Error(`duração inválida: ${seconds}`));
  }
  const key = `still@${seconds}`;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const job = writeStill(seconds).catch((err: unknown) => {
    pending.delete(key);
    throw err;
  });
  pending.set(key, job);
  return job;
}

async function writeStill(seconds: number): Promise<string> {
  await mkdir(GENERATED, { recursive: true });
  const dest = join(GENERATED, `still-${seconds}s.mp4`);
  if (await stat(dest).then((info) => info.size > 0, () => false)) return dest;
  const tmp = join(GENERATED, `.still-${seconds}-${process.pid}-${randomBytes(4).toString("hex")}.tmp.mp4`);
  try {
    await run("ffmpeg", [
      "-v", "error",
      "-y",
      "-f", "lavfi", "-i", `color=c=black:s=16x16:r=1:d=${seconds}`,
      "-frames:v", String(seconds),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p",
      "-an",
      "-movflags", "+faststart",
      tmp,
    ]);
    try {
      await rename(tmp, dest);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      const raced = err as NodeJS.ErrnoException;
      if (raced.code !== "EEXIST" || !(await stat(dest).then((info) => info.size > 0, () => false))) {
        throw err;
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return dest;
}

/** MP4 cuja duração é a da montagem (max startFrame + durationFrames). */
export function referenceForAssembly(assembly: {
  fps: { num: number; den: number };
  tracks: { clips: { startFrame: number; durationFrames: number }[] }[];
}): Promise<string> {
  const fps = assembly.fps.num / assembly.fps.den;
  let frames = 0;
  for (const track of assembly.tracks) {
    for (const clip of track.clips) frames = Math.max(frames, clip.startFrame + clip.durationFrames);
  }
  return exactReferenceMp4(frames, fps);
}
