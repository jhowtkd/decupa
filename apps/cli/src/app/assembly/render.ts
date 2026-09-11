import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Executor } from "../pipeline.ts";
import type { Assembly, Source, Track } from "./types.ts";
import { validateAssembly } from "./validate.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const RENDER_SCRIPT = join(REPO_ROOT, "scripts", "render-assembly.py");

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} precisa ser um caminho absoluto: ${path}`);
  }
  return path;
}

function clipReason(source: Source, track: Track): string {
  if (track.kind === "Audio") return "speech";
  if (source.role === "support") return "support";
  return "speech";
}

function engineAsset(source: Source) {
  const path = absolutePath(source.path, `fonte ${source.id}`);
  return {
    id: source.id,
    path,
    uri: path,
    name: basename(path),
    role: source.role,
    has_video: source.hasVideo,
    has_audio: source.hasAudio,
  };
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

function engineClip(
  clip: Assembly["tracks"][number]["clips"][number],
  source: Source,
  track: Track,
  fps: number,
) {
  const path = absolutePath(source.path, `fonte ${source.id}`);
  const reason = clipReason(source, track);
  const muted = track.kind !== "Audio";
  const durationSeconds = framesToSeconds(clip.durationFrames, fps);
  return {
    id: clip.id,
    source: path,
    path,
    asset_id: source.id,
    start: clip.sourceStartSeconds,
    end: clip.sourceStartSeconds + durationSeconds,
    in_point: clip.sourceStartSeconds,
    out_point: clip.sourceStartSeconds + durationSeconds,
    timeline_start: framesToSeconds(clip.startFrame, fps),
    volume: muted ? 0 : 1,
    muted,
    speed: 1,
    reason,
  };
}

export function toEngineTimeline(a: Assembly): object {
  const valid = validateAssembly(a);
  const fps = valid.fps.num / valid.fps.den;
  const sources = new Map(valid.sources.map((source) => [source.id, source]));
  const assets = valid.sources.map(engineAsset);
  const tracks = valid.tracks.map((track, index) => ({
    type: track.kind === "Video" ? "video" : "audio",
    name: track.name,
    order: index + 1,
    clips: track.clips.map((clip) => {
      const source = sources.get(clip.sourceId);
      if (!source) {
        throw new Error(`clipe ${clip.id} referencia fonte ausente ${clip.sourceId}`);
      }
      return engineClip(clip, source, track, fps);
    }),
  }));
  const output_canvas = {
    width: valid.width,
    height: valid.height,
    fps,
  };
  const project = {
    name: valid.name,
    revision: valid.revision,
    width: valid.width,
    height: valid.height,
    fps: output_canvas.fps,
    assets,
    tracks,
    output_canvas,
    sequence: output_canvas,
  };
  return { project, assets, tracks, output_canvas, sequence: output_canvas };
}

export async function renderAssembly(
  a: Assembly,
  outDir: string,
  exec: Executor,
): Promise<string> {
  const valid = validateAssembly(a);
  const published = join(outDir, `rev-${valid.revision}`);
  const work = join(
    published,
    `.work-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(work, { recursive: true });
  const timelinePath = join(work, "timeline.json");
  const outPath = join(work, "reference.mp4");
  await writeFile(timelinePath, `${JSON.stringify(toEngineTimeline(valid), null, 2)}\n`, "utf8");

  try {
    const result = await exec.run({
      command: "python3",
      args: [RENDER_SCRIPT, "--timeline", timelinePath, "--out", outPath, "--work", work],
      cwd: work,
      env: { CLAUDE_PROJECT_DIR: work },
    });
    if (result.code !== 0) {
      const detail = (result.stdout + result.stderr).trim().slice(0, 1500);
      throw new Error(`render falhou (código ${result.code}): ${detail || "sem saída"}`);
    }

    const exists = await access(outPath).then(() => true, () => false);
    if (!exists) {
      throw new Error(`render concluiu sem o mp4 de saída em ${outPath}`);
    }
    const dest = join(published, "reference.mp4");
    const tmp = join(
      published,
      `.reference-${process.pid}-${randomBytes(4).toString("hex")}.tmp.mp4`,
    );
    await rename(outPath, tmp);
    await rename(tmp, dest);
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
