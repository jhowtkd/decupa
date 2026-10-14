import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { fixtureAssembly } from "./fixture.ts";
import { toEngineTimeline } from "./render.ts";
import { validateAssembly } from "./validate.ts";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
// Mesmo critério do render.test.ts: o motor não é clonado no CI.
const ENGINE = process.env.VE_PLUGIN_ROOT ?? join(REPO, "work", "video-agent-kit-plugin");
const temMotor = await access(join(ENGINE, "mcp", "ve_tools", "render.py")).then(() => true, () => false);

const CUTS = 40;
const CUT_FRAMES = 15; // 0,5 s a 30 fps
const SAMPLE_RATE = 16000;

async function tone(dir: string, name: string, hz: number): Promise<string> {
  const path = join(dir, name);
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x120:r=30:d=30",
    "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=30`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
  return path;
}

async function bytesUnder(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? await bytesUnder(full) : (await stat(full)).size;
  }
  return total;
}

it.skipIf(!temMotor)("muitos cortes de áudio: disco proporcional à timeline e cada corte no lugar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-cuts-"));
  const low = await tone(dir, "low.mp4", 440);
  const high = await tone(dir, "high.mp4", 880);
  const assembly = fixtureAssembly();
  assembly.fps = { num: 30, den: 1 };
  assembly.width = 160;
  assembly.height = 120;
  const source = async (id: string, path: string) => ({
    id, path, sha256: await hashFile(path), durationSeconds: 30, hasVideo: true, hasAudio: true,
    fps: { num: 30, den: 1 }, width: 160, height: 120, role: "speech" as const, included: true, name: `${id}.mp4`,
  });
  assembly.sources = [await source("low", low), await source("high", high)];
  // Cortes contíguos alternando as fontes, cada um de um ponto diferente da fonte.
  const clips = Array.from({ length: CUTS }, (_, i) => ({
    id: `c${i}`, sceneId: "s", sourceId: i % 2 === 0 ? "low" : "high",
    sourceStartSeconds: (i * 0.7) % 20, startFrame: i * CUT_FRAMES, durationFrames: CUT_FRAMES,
  }));
  assembly.tracks = [
    { kind: "Video", name: "V1", clips: clips.map((clip) => ({ ...clip, id: `${clip.id}-v` })) },
    { kind: "Video", name: "V2", clips: [] },
    { kind: "Audio", name: "A1", clips: clips.map((clip) => ({ ...clip, id: `${clip.id}-a` })) },
  ];
  const work = join(dir, "work");
  await mkdir(work);
  const timeline = join(work, "timeline.json");
  await writeFile(timeline, JSON.stringify(toEngineTimeline(validateAssembly(assembly))));
  const out = join(work, "reference.mp4");
  await run("python3", [join(REPO, "scripts", "render-assembly.py"),
    "--timeline", timeline, "--out", out, "--work", work, "--encoder", "libx264"],
  { cwd: work, env: { ...process.env, CLAUDE_PROJECT_DIR: work, VE_PLUGIN_ROOT: ENGINE }, maxBuffer: 64 * 1024 * 1024 });

  // Um WAV estéreo 48 kHz de 16 bits da timeline inteira: 192 kB/s.
  const timelineSeconds = (CUTS * CUT_FRAMES) / 30;
  const fullBed = timelineSeconds * 48000 * 2 * 2;
  // Antes: um WAV da timeline inteira por corte (40x). Agora a pista vira um só.
  expect(await bytesUnder(join(work, "audio_beds"))).toBeLessThan(4 * fullBed);

  const pcm = join(dir, "mix.pcm");
  await run("ffmpeg", ["-v", "error", "-y", "-i", out, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", pcm]);
  const samples = await readFile(pcm);
  const energy = (hz: number, from: number, to: number) => {
    let re = 0, im = 0;
    for (let i = from; i < to; i++) {
      const sample = samples.readInt16LE(i * 2);
      const phase = 2 * Math.PI * hz * i / SAMPLE_RATE;
      re += sample * Math.cos(phase);
      im += sample * Math.sin(phase);
    }
    return re * re + im * im;
  };
  // Miolo de cada corte (sem as bordas): o tom esperado domina, do primeiro ao último.
  for (let i = 0; i < CUTS; i++) {
    const start = Math.round((i * 0.5 + 0.1) * SAMPLE_RATE);
    const end = Math.round((i * 0.5 + 0.4) * SAMPLE_RATE);
    const [want, other] = i % 2 === 0 ? [440, 880] : [880, 440];
    expect(energy(want, start, end), `corte ${i}`).toBeGreaterThan(20 * energy(other, start, end));
  }
}, 300_000);
