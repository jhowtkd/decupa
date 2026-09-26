import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { SpawnExecutor } from "../pipeline.ts";
import { fixtureAssembly } from "./fixture.ts";
import { extractVisualFrames, type VisualWindow } from "./frames.ts";
import type { Source } from "./types.ts";

const run = promisify(execFile);

async function ff(args: string[]): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", ...args]);
}

/**
 * Fontes sintéticas com o contador do testsrc (muda a cada quadro): um frame
 * de segundo errado não passa no SSIM. Mesmos casos de visual-seek.test.ts.
 */
async function makeFixture(dir: string, kind: "cfr" | "vfr" | "offset" | "gop" | "rot"): Promise<string> {
  const out = join(dir, `${kind}.mp4`);
  const src = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=10"];
  const enc = ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p"];
  if (kind === "cfr") await ff([...src, ...enc, "-g", "25", out]);
  else if (kind === "vfr") {
    const input = [...src, "-vf", "setpts=N/(25*TB)+0.04*sin(N/8)"];
    try {
      await ff([...input, "-fps_mode", "vfr", ...enc, out]);
    } catch {
      await ff([...input, "-vsync", "vfr", ...enc, out]);
    }
  } else if (kind === "offset") await ff([...src, "-output_ts_offset", "1.5", ...enc, out]);
  else if (kind === "gop") await ff([...src, ...enc, "-g", "250", "-keyint_min", "250", out]);
  else await ff([...src, "-vf", "transpose=1", ...enc, "-metadata:s:v:0", "rotate=90", out]);
  return out;
}

/** Referência: a ordem antiga (busca na saída), que define o contrato das janelas. */
async function outputSeekFrames(input: string, window: VisualWindow, dir: string): Promise<string[]> {
  await ff([
    "-i", input,
    "-ss", String(window.fetchStart),
    "-t", String(window.end - window.fetchStart),
    "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
    "-an", "-q:v", "5", join(dir, "frame-%03d.jpg"),
  ]);
  return (await readdir(dir))
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort()
    .filter((_, index) => window.fetchStart + index < window.end)
    .map((name) => join(dir, name));
}

async function ssim(a: string, b: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"]);
  const match = /All:([0-9.]+)/.exec(stderr);
  if (!match) throw new Error("ssim sem resultado");
  return Number(match[1]);
}

it("busca na entrada devolve os mesmos segundos e quadros da busca na saída", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frames-seek-"));
  const exec = new SpawnExecutor();
  // Primeira janela, janela do meio e última janela com fim fracionário.
  const windows: VisualWindow[] = [
    { start: 0, end: 3, fetchStart: 0 },
    { start: 4, end: 6, fetchStart: 3 },
    { start: 7, end: 9.6, fetchStart: 6 },
  ];
  for (const kind of ["cfr", "vfr", "offset", "gop", "rot"] as const) {
    const path = await makeFixture(dir, kind);
    const source: Source = { ...fixtureAssembly().sources[0]!, id: kind, path, durationSeconds: 10, hasVideo: true };
    for (const window of windows) {
      const label = `${kind} [${window.fetchStart}, ${window.end})`;
      const frames = await extractVisualFrames(source, window, exec);
      const refDir = await mkdtemp(join(dir, "ref-"));
      const reference = await outputSeekFrames(path, window, refDir);

      expect(frames.map((f) => f.sourceSecond), label)
        .toEqual(reference.map((_, index) => window.fetchStart + index));
      for (const [index, frame] of frames.entries()) {
        const got = join(refDir, `got-${index}.jpg`);
        await writeFile(got, Buffer.from(frame.dataUrl.split(",")[1]!, "base64"));
        expect(await ssim(got, reference[index]!), `${label} frame ${index}`).toBeGreaterThanOrEqual(0.98);
      }
    }
  }
}, 120_000);
