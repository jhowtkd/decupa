import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.platform === "win32" ? "python" : "python3";
const FRAME = 1 / 30;
const CLIPS: [number, number][] = [[0.4, 2.9], [3.2, 4.75], [5.1, 6.6], [7.0, 9.35], [9.8, 11.5]];
const EXPECTED = CLIPS.reduce((sum, [a, b]) => sum + (b - a), 0);

/** Fonte com um flash branco e um bipe no início de cada segundo, em sincronia exata. */
async function source(dir: string): Promise<string> {
  const out = join(dir, "sync.mp4");
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=12,drawbox=x=0:y=0:w=320:h=240:color=white:t=fill:enable='lt(mod(t\\,1)\\,0.034)'",
    "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t\\,1)\\,0.03)\\,sin(2*PI*1000*t)\\,0)':s=48000:d=12",
    "-c:v", "libx264", "-g", "30", "-bf", "2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", out,
  ]);
  return out;
}

/** Corta com o comando no formato do `_cut_segment` do motor e junta pelo wrapper. */
async function render(src: string, out: string, fixStart: boolean): Promise<void> {
  const code = `
import json, subprocess
from pathlib import Path
from segment_cut import start_at_zero
from concat_copy import concat_video_copy
clips = ${JSON.stringify(CLIPS)}
segs = []
for n, (a, b) in enumerate(clips):
    d = b - a
    p = Path(${JSON.stringify(out)}).with_name(f"seg_{n}.mp4")
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{a:.6f}", "-t", f"{d:.6f}", "-i", ${JSON.stringify(src)},
           "-map", "0:v:0", "-map", "0:a:0",
           "-vf", "scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
           "-r", "30.000000", "-af", f"afade=t=in:st=0:d=0.008,afade=t=out:st={d - 0.008:.6f}:d=0.008",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-ar", "48000", "-ac", "2",
           "-shortest", "-avoid_negative_ts", "make_zero", str(p)]
    if ${fixStart ? "True" : "False"}:
        cmd = start_at_zero(cmd)
    subprocess.run(cmd, check=True)
    segs.append({"path": str(p)})
assert concat_video_copy(segs, ${JSON.stringify(out)}, crf=18) is None
print("ok")
`;
  await run(PYTHON, ["-c", code], { env: { ...process.env, PYTHONPATH: SCRIPTS } });
}

async function duration(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(stdout.trim());
}

/** Tempos dos flashes (luma alta) e dos bipes (primeira amostra alta) na saída. */
async function events(path: string): Promise<{ flashes: number[]; beeps: number[] }> {
  const { stdout: frames } = await run("ffmpeg", [
    "-v", "error", "-i", path, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }) as unknown as { stdout: Buffer };
  const flashes: number[] = [];
  let prev = 0;
  for (let i = 0; i * 64 < frames.length; i += 1) {
    const luma = frames.subarray(i * 64, i * 64 + 64).reduce((a, b) => a + b, 0) / 64;
    if (luma > 128 && prev <= 128) flashes.push(i * FRAME);
    prev = luma;
  }
  const { stdout: pcm } = await run("ffmpeg", [
    "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
  ], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }) as unknown as { stdout: Buffer };
  const beeps: number[] = [];
  let last = -1;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const t = i / 2 / 48000;
    if (Math.abs(pcm.readInt16LE(i)) > 3000 && t - last > 0.5) {
      beeps.push(t);
      last = t;
    }
  }
  return { flashes, beeps };
}

function offsetsMs(ev: { flashes: number[]; beeps: number[] }): number[] {
  return ev.flashes.map((f) => {
    const near = ev.beeps.reduce((best, b) => (Math.abs(b - f) < Math.abs(best - f) ? b : best), Infinity);
    return (near - f) * 1000;
  });
}

it("segmentos começando em zero: duração do plano e áudio em sincronia após a junção", async () => {
  const dir = await mkdtemp(join(tmpdir(), "segment-timing-"));
  const src = await source(dir);
  const out = join(dir, "fixed.mp4");
  await render(src, out, true);
  expect(Math.abs(await duration(out) - EXPECTED)).toBeLessThan(FRAME);
  const ev = await events(out);
  expect(ev.flashes.length).toBeGreaterThanOrEqual(8);
  expect(ev.beeps).toHaveLength(ev.flashes.length);
  for (const ms of offsetsMs(ev)) expect(Math.abs(ms)).toBeLessThan(FRAME * 1000);
}, 120_000);

it("com o make_zero do motor a exportação cresce a cada corte e o áudio escorrega", async () => {
  const dir = await mkdtemp(join(tmpdir(), "segment-timing-old-"));
  const src = await source(dir);
  const out = join(dir, "old.mp4");
  await render(src, out, false);
  // Cada corte acrescenta a folga do atraso de B-frames/priming (~23 ms aqui):
  // em 5 cortes já passa de 2 quadros.
  expect(await duration(out) - EXPECTED).toBeGreaterThan(2 * FRAME);
  const offsets = offsetsMs(await events(out));
  expect(Math.max(...offsets.map(Math.abs))).toBeGreaterThan(FRAME * 1000);
}, 120_000);
