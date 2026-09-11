#!/usr/bin/env node
/**
 * Prova de intercâmbio: gera fontes sintéticas, assembly, OTIO e tenta o MP4
 * da mesma revisão. Reexecutável — cada corrida usa um diretório novo.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hashFile } from "../packages/media/src/hash.ts";
import { fixtureAssembly } from "../apps/cli/src/app/assembly/fixture.ts";
import { buildOtio } from "../apps/cli/src/app/assembly/otio.ts";
import { renderAssembly, toEngineTimeline } from "../apps/cli/src/app/assembly/render.ts";
import { davinciImportSettings } from "../apps/cli/src/app/assembly/otio.ts";
import { validateAssembly } from "../apps/cli/src/app/assembly/validate.ts";
import { SpawnExecutor } from "../apps/cli/src/app/pipeline.ts";
import type { Assembly, Rate } from "../apps/cli/src/app/assembly/types.ts";

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF_ROOT = join(REPO_ROOT, "work", "assembly-proof");

async function probeMeta(path: string) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: { timecode?: string } };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      start_time?: string;
      tags?: { timecode?: string };
    }>;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: num && den ? { num, den } : null,
    durationSeconds: Number(parsed.format?.duration ?? 0),
    timecode: video?.tags?.timecode ?? parsed.format?.tags?.timecode ?? null,
    startTime: Number(video?.start_time ?? 0),
  };
}

async function makeSources(dir: string): Promise<{ sourceA: string; sourceB: string }> {
  const sourceA = join(dir, "fala.mp4");
  const sourceB = join(dir, "apoio.mp4");
  await run("ffmpeg", [
    "-n", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    sourceA,
  ]);
  await run("ffmpeg", [
    "-n", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    sourceB,
  ]);
  return { sourceA, sourceB };
}

async function makeFractionalSources(dir: string): Promise<{ sourceA: string; sourceB: string }> {
  const sourceA = join(dir, "fala-30000-1001.mp4");
  const sourceB = join(dir, "apoio-25.mp4");
  await run("ffmpeg", [
    "-n", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30000/1001:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-timecode", "01:00:00:00",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    sourceA,
  ]);
  await run("ffmpeg", [
    "-n", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    sourceB,
  ]);
  return { sourceA, sourceB };
}

async function writeAssembly(
  dir: string,
  sourceA: string,
  sourceB: string,
  timelineFps: Rate,
): Promise<{ valid: Assembly; jsonPath: string; otioPath: string; enginePath: string; meta: unknown }> {
  if (!isAbsolute(sourceA) || !isAbsolute(sourceB)) {
    throw new Error("as fontes da prova precisam ser caminhos absolutos");
  }
  const metaA = await probeMeta(sourceA);
  const metaB = await probeMeta(sourceB);
  const assembly = fixtureAssembly();
  assembly.name = `assembly-proof-${timelineFps.num}-${timelineFps.den}`;
  assembly.fps = timelineFps;
  assembly.width = metaA.width ?? assembly.width;
  assembly.height = metaA.height ?? assembly.height;
  assembly.sources[0]!.path = sourceA;
  assembly.sources[1]!.path = sourceB;
  assembly.sources[0]!.sha256 = await hashFile(sourceA);
  assembly.sources[1]!.sha256 = await hashFile(sourceB);
  assembly.sources[0]!.fps = metaA.fps;
  assembly.sources[1]!.fps = metaB.fps;
  assembly.sources[0]!.width = metaA.width;
  assembly.sources[0]!.height = metaA.height;
  assembly.sources[1]!.width = metaB.width;
  assembly.sources[1]!.height = metaB.height;
  assembly.sources[0]!.durationSeconds = metaA.durationSeconds || assembly.sources[0]!.durationSeconds;
  assembly.sources[1]!.durationSeconds = metaB.durationSeconds || assembly.sources[1]!.durationSeconds;
  const valid = validateAssembly(assembly);
  const jsonPath = join(dir, "assembly.json");
  const otioPath = join(dir, "timeline.otio");
  const enginePath = join(dir, "engine-timeline.json");
  await writeFile(jsonPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
  await writeFile(otioPath, `${buildOtio(valid)}\n`, "utf8");
  await writeFile(enginePath, `${JSON.stringify(toEngineTimeline(valid), null, 2)}\n`, "utf8");
  return {
    valid,
    jsonPath,
    otioPath,
    enginePath,
    meta: { a: metaA, b: metaB },
  };
}

async function tryRender(valid: Assembly, dir: string) {
  try {
    const path = await renderAssembly(valid, dir, new SpawnExecutor());
    return { ok: true as const, path };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  await mkdir(PROOF_ROOT, { recursive: true });
  const dir = await mkdtemp(join(PROOF_ROOT, "run-"));
  const { sourceA, sourceB } = await makeSources(dir);
  const baseline = await writeAssembly(dir, sourceA, sourceB, { num: 25, den: 1 });
  const baselineRender = await tryRender(baseline.valid, dir);

  const fractionalDir = await mkdtemp(join(PROOF_ROOT, "run-frac-"));
  const fractional = await makeFractionalSources(fractionalDir);
  const fractionalOut = await writeAssembly(
    fractionalDir,
    fractional.sourceA,
    fractional.sourceB,
    { num: 30000, den: 1001 },
  );
  const fractionalRender = await tryRender(fractionalOut.valid, fractionalDir);

  const report = {
    dir,
    jsonPath: baseline.jsonPath,
    otioPath: baseline.otioPath,
    enginePath: baseline.enginePath,
    sourceA,
    sourceB,
    hashes: {
      a: baseline.valid.sources[0]!.sha256,
      b: baseline.valid.sources[1]!.sha256,
    },
    render: baselineRender,
    davinciImport: davinciImportSettings(baseline.valid),
    fractional: {
      dir: fractionalDir,
      otioPath: fractionalOut.otioPath,
      enginePath: fractionalOut.enginePath,
      fps: fractionalOut.valid.fps,
      sourceA: fractional.sourceA,
      sourceB: fractional.sourceB,
      canvas: {
        width: fractionalOut.valid.width,
        height: fractionalOut.valid.height,
      },
      sources: fractionalOut.valid.sources.map((s) => ({
        id: s.id, path: s.path, width: s.width, height: s.height, fps: s.fps,
      })),
      meta: fractionalOut.meta,
      render: fractionalRender,
      davinciImport: davinciImportSettings(fractionalOut.valid),
    },
  };
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!baselineRender.ok || !fractionalRender.ok) {
    if (!baselineRender.ok) console.error(baselineRender.error);
    if (!fractionalRender.ok) console.error(fractionalRender.error);
    process.exitCode = 2;
  }
}

await main();
