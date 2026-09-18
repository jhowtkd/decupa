import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { hashFile } from "@decupa/media";
import { SpawnExecutor } from "../pipeline.ts";
import { visualWindowClipArgs } from "./model.ts";
import { visualWindows } from "./visual.ts";

const run = promisify(execFile);

async function ff(args: string[]): Promise<void> {
  await run("ffmpeg", ["-v", "error", "-y", ...args]);
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    path,
  ]);
  return Number(stdout.trim());
}

async function firstFrameHash(path: string, dir: string, name: string): Promise<string> {
  const png = join(dir, `${name}.png`);
  await ff(["-i", path, "-frames:v", "1", png]);
  return hashFile(png);
}

async function extract(
  exec: SpawnExecutor,
  input: string,
  window: { start: number; end: number; fetchStart: number },
  output: string,
): Promise<void> {
  const result = await exec.run({ command: "ffmpeg", args: visualWindowClipArgs(input, window, output) });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "ffmpeg falhou");
  }
}

async function makeFixture(dir: string, kind: "cfr" | "vfr" | "offset" | "gop" | "rot"): Promise<string> {
  const out = join(dir, `${kind}.mp4`);
  if (kind === "cfr") {
    await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", out,
    ]);
  } else if (kind === "vfr") {
    const encode = ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", out];
    const input = [
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8",
      "-vf", "setpts=N/(25*TB)+0.04*sin(N/8)",
    ];
    try {
      await ff([...input, "-fps_mode", "vfr", ...encode]);
    } catch {
      await ff([...input, "-vsync", "vfr", ...encode]);
    }
  } else if (kind === "offset") {
    await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=10",
      "-ss", "2", "-t", "8",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
    ]);
  } else if (kind === "gop") {
    await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "250", "-keyint_min", "250", out,
    ]);
  } else {
    await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8",
      "-vf", "transpose=1",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-metadata:s:v:0", "rotate=90", out,
    ]);
  }
  return out;
}

it("visualWindowClipArgs coloca -ss antes de -i e 1s de contexto, sem copy", () => {
  const window = visualWindows(45)[1]!;
  const args = visualWindowClipArgs("/src.mp4", window, "/out.mp4");
  expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  expect(args[args.indexOf("-ss") + 1]).toBe("19");
  expect(args[args.indexOf("-t") + 1]).toBe("21");
  expect(args.join(" ")).not.toMatch(/\bcopy\b/);
  expect(args).toContain("-c:v");
});

it("CFR/VFR/início não zero/GOP longo/rotação preservam duração e quadro de origem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-seek-"));
  const exec = new SpawnExecutor();
  const window = { start: 2, end: 4, fetchStart: 1 };
  for (const kind of ["cfr", "vfr", "offset", "gop", "rot"] as const) {
    const input = await makeFixture(dir, kind);
    const out = join(dir, `${kind}-win.mp4`);
    await extract(exec, input, window, out);
    const duration = await probeDuration(out);
    expect(duration, kind).toBeGreaterThan(1.5);
    expect(duration, kind).toBeLessThan(3.5);
    const hash = await firstFrameHash(out, dir, kind);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await writeIdentity(dir, kind, { duration, hash });
  }
});

async function writeIdentity(
  dir: string,
  kind: string,
  rec: { duration: number; hash: string },
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await mkdir(join(dir, "identity"), { recursive: true });
  await writeFile(join(dir, "identity", `${kind}.json`), `${JSON.stringify(rec)}\n`);
}

it("benchmark de seek de entrada com 3 repetições no mesmo hardware", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-bench-"));
  const input = await makeFixture(dir, "gop");
  const exec = new SpawnExecutor();
  const window = { start: 2, end: 4, fetchStart: 1 };
  const times: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const out = join(dir, `rep-${i}.mp4`);
    const t0 = Date.now();
    await extract(exec, input, window, out);
    times.push(Date.now() - t0);
    expect(await probeDuration(out)).toBeGreaterThan(1);
  }
  expect(times).toHaveLength(3);
  const report = {
    caseId: "m1-visual-input-seek",
    hardware: `${process.platform}-${process.arch}`,
    versions: { node: process.version },
    repetitions: times,
    p50: [...times].sort((a, b) => a - b)[1],
  };
  expect(report.repetitions.every((ms) => ms >= 0)).toBe(true);
  expect(await readFile(input).then((buf) => buf.length)).toBeGreaterThan(0);
});
