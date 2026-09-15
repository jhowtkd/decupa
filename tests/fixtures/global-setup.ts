import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "generated");

/** Verdade absoluta dos fixtures. Os testes comparam contra estes números. */
export const TRUTH = {
  /** tone-gap.wav: silêncio exato entre 1000 ms e 1600 ms, duração total 2600 ms */
  toneGapSilence: { startMs: 1000, endMs: 1600 },
  toneGapDurationMs: 2600,
  /** clip.mp4: 3000 ms, 320x240, 25 fps */
  clipDurationMs: 3000,
  /** par raw.wav (6000 ms) -> edited.wav (4600 ms): estes intervalos foram removidos */
  removed: [
    { startMs: 1200, endMs: 2000 },
    { startMs: 3500, endMs: 4100 },
  ],
} as const;

const exists = (p: string) => access(p).then(() => true, () => false);
const ff = (args: string[]) => run("ffmpeg", ["-v", "error", "-y", ...args]);

export default async function setup(): Promise<void> {
  await mkdir(FIXTURES, { recursive: true });

  const clip = join(FIXTURES, "clip.mp4");
  if (!(await exists(clip))) {
    await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      clip,
    ]);
  }

  const toneGap = join(FIXTURES, "tone-gap.wav");
  if (!(await exists(toneGap))) {
    await ff([
      "-f", "lavfi", "-i",
      "aevalsrc=exprs='if(between(t,1,1.6),0,0.4*sin(2*PI*440*t))':s=16000:d=2.6",
      "-ac", "1", "-c:a", "pcm_s16le", toneGap,
    ]);
  }

  const raw = join(FIXTURES, "raw.wav");
  if (!(await exists(raw))) {
    await ff([
      "-f", "lavfi", "-i",
      "aevalsrc=exprs='0.35*sin(2*PI*(200+120*t)*t)+0.15*sin(2*PI*(1100-90*t)*t)':s=16000:d=6.0",
      "-ac", "1", "-c:a", "pcm_s16le", raw,
    ]);
  }

  const edited = join(FIXTURES, "edited.wav");
  if (!(await exists(edited))) {
    await ff([
      "-i", raw, "-filter_complex",
      "[0]atrim=0:1.2,asetpts=N/SR/TB[a];" +
      "[0]atrim=2.0:3.5,asetpts=N/SR/TB[b];" +
      "[0]atrim=4.1:6.0,asetpts=N/SR/TB[c];" +
      "[a][b][c]concat=n=3:v=0:a=1",
      "-c:a", "pcm_s16le", edited,
    ]);
  }
}
