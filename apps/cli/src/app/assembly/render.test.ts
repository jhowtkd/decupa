import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeExecutor, type Executor } from "../pipeline.ts";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { fixtureAssembly } from "./fixture.ts";
import { ensurePlayback, proxyPath } from "./media.ts";
import { mediaWork } from "./media-work.ts";
import { renderAssembly, previewIdentity, toEngineTimeline } from "./render.ts";
import { validateAssembly } from "./validate.ts";

it("preserva as três pistas e não duplica áudio", () => {
  const result = toEngineTimeline(fixtureAssembly()) as {
    project: { assets: unknown[]; name: string };
    assets: { id: string; path: string }[];
    tracks: any[];
  };
  expect(result.project.name).toBe("fixture");
  expect(result.project.assets).toHaveLength(2);
  expect(result.assets).toHaveLength(2);
  expect(result.tracks.map(t => t.type)).toEqual(["video", "video", "audio"]);
  expect(result.tracks[0].clips[0].volume).toBe(0);
  expect(result.tracks[0].clips[0].muted).toBe(true);
  expect(result.tracks[1].clips[0].muted).toBe(true);
  expect(result.tracks[0].clips[0].reason).toBe("speech");
  expect(result.tracks[1].clips[0].reason).toBe("support");
  expect(result.tracks[2].clips[0].volume).toBe(1);
  expect(result.tracks[2].clips[0].muted).toBe(false);
  expect(result.tracks[2].clips[0].reason).toBe("speech");
  expect(result.tracks[1].clips[0].timeline_start).toBe(1);
  expect(result.tracks.every((t) => t.clips.every((c: { reason: string }) => c.reason))).toBe(true);
});

it("recusa path relativo no contrato do motor", () => {
  const a = fixtureAssembly();
  a.sources[0]!.path = "fala.mp4";
  expect(() => toEngineTimeline(a)).toThrow(/absoluto/);
});

async function assemblyWithMedia(dir: string) {
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = await hashFile(media);
  }
  return assembly;
}

it("não trata falha do Executor como sucesso", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const exec = new FakeExecutor({ code: 1, stderr: "[ERROR] motor ausente" });
  await expect(renderAssembly(await assemblyWithMedia(dir), dir, exec)).rejects.toThrow(/render|falhou|código 1/i);
});

it("não declara sucesso se o mp4 não existe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const exec = new FakeExecutor({ code: 0, stdout: "ok" });
  await expect(renderAssembly(await assemblyWithMedia(dir), dir, exec)).rejects.toThrow(/saída|mp4|não/i);
});

it("devolve o mp4 quando o Executor conclui e o arquivo existe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = await hashFile(media);
  }
  const exec: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await expect(renderAssembly(assembly, dir, exec)).resolves.toBe(
    join(dir, "rev-1", "reference.mp4"),
  );
});

it("recusa fonte substituída antes de renderizar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  assembly.sources[0]!.path = media;
  assembly.sources[0]!.sha256 = "0".repeat(64);
  const exec: Executor = {
    async run() {
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await expect(renderAssembly(assembly, dir, exec)).rejects.toThrow(/substituída/);
});

it("render inválido não substitui a prévia válida anterior (V1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = await assemblyWithMedia(dir);
  const good: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  const dest = await renderAssembly(assembly, dir, good);
  const before = await hashFile(dest);
  const bad: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await writeFile(join(work, "reference.mp4"), "bytes-inválidos");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await expect(renderAssembly(assembly, dir, bad)).resolves.toBe(dest);
  await expect(hashFile(dest)).resolves.toBe(before);
});

it("concorrentes válido + inválido preservam referência válida (V1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const assembly = await assemblyWithMedia(dir);
  const good: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await new Promise((r) => setTimeout(r, 30));
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  const bad: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await writeFile(join(work, "reference.mp4"), "lixo");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  const results = await Promise.allSettled([
    renderAssembly(assembly, dir, good),
    renderAssembly(assembly, dir, bad),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const dest = join(dir, "rev-1", "reference.mp4");
  const { probe } = await import("@decupa/media");
  const info = await probe(dest);
  expect(info.durationMs).toBeGreaterThan(0);
});

it("proxy e render simultâneos executam um pesado por vez", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-shared-budget-"));
  const assembly = await assemblyWithMedia(dir);
  const source = assembly.sources[0]!;
  let active = 0, peak = 0, gated = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exec: Executor = {
    async run(call) {
      const heavy = call.command === "ffmpeg" || call.command === "python3";
      if (!heavy) return { code: 0, stdout: "", stderr: "" };
      active++;
      peak = Math.max(peak, active);
      try {
        if (!gated) {
          gated = true;
          await gate;
        }
        const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
        if (call.command === "python3" && work) {
          await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
        } else {
          const out = call.args.at(-1)!;
          if (out.endsWith(".tmp.mp4")) await copyFile(join(FIXTURES, "clip.mp4"), out);
          else if (out.endsWith(".tmp.jpg")) await writeFile(out, "miniatura");
        }
        return { code: 0, stdout: "", stderr: "" };
      } finally {
        active--;
      }
    },
  };
  try {
    const both = Promise.all([
      ensurePlayback(source, dir, exec),
      renderAssembly(assembly, dir, exec),
    ]);
    await vi.waitFor(() => {
      expect(gated).toBe(true);
      expect(mediaWork.waiting).toBeGreaterThanOrEqual(1);
    });
    release();
    const [playback, dest] = await both;
    expect(peak).toBe(1);
    expect(playback.videoPath).toBe(proxyPath(dir, source.sha256));
    expect(dest).toBe(join(dir, "rev-1", "reference.mp4"));
  } finally {
    release();
  }
});

it("render cancelado na fila não lança ffmpeg e preserva a referência", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-cancel-"));
  const assembly = await assemblyWithMedia(dir);
  const dest = await renderAssembly(assembly, dir, copyingRenderExec());
  const before = await hashFile(dest);
  const calls: { command: string; args: string[] }[] = [];
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exec: Executor = {
    async run(call) {
      calls.push({ command: call.command, args: call.args });
      if (call.command === "ffmpeg" || call.command === "python3") {
        entered++;
        await gate;
        const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
        if (call.command === "python3" && work) {
          await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
        } else {
          const out = call.args.at(-1)!;
          if (out.endsWith(".tmp.mp4")) await copyFile(join(FIXTURES, "clip.mp4"), out);
          else if (out.endsWith(".tmp.jpg")) await writeFile(out, "miniatura");
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const controller = new AbortController();
  try {
    const pending = Promise.allSettled([
      ensurePlayback(assembly.sources[0]!, dir, exec),
      renderAssembly(assembly, dir, exec, { profile: "nvenc", signal: controller.signal }),
    ]);
    await vi.waitFor(() => {
      expect(entered).toBe(1);
      expect(mediaWork.waiting).toBeGreaterThanOrEqual(1);
    });
    controller.abort();
    release();
    const [playback, render] = await pending;
    expect(playback.status).toBe("fulfilled");
    expect(render.status).toBe("rejected");
    expect(calls.filter((c) => c.command === "python3")).toHaveLength(0);
    expect(await hashFile(dest)).toBe(before);
  } finally {
    release();
  }
});

it("mapeia startFrame 25 no mesmo fps float do canvas em 25 e 30000/1001", () => {
  for (const fps of [{ num: 25, den: 1 }, { num: 30000, den: 1001 }]) {
    const assembly = fixtureAssembly();
    assembly.fps = fps;
    const result = toEngineTimeline(assembly) as {
      output_canvas: { fps: number };
      tracks: { clips: { timeline_start: number; startFrame?: number }[] }[];
    };
    const canvasFps = result.output_canvas.fps;
    expect(canvasFps).toBe(fps.num / fps.den);
    const start = result.tracks[1]!.clips[0]!.timeline_start;
    expect(start).toBe(25 / canvasFps);
    expect(Math.round(start * canvasFps)).toBe(25);
  }
});

it("render segmentado de 12s preserva bordas, voz contínua e portrait VFR em 30000/1001", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const { SpawnExecutor } = await import("../pipeline.ts");
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "decupa-seg-"));
  const fps = { num: 30000, den: 1001 };
  const frame = fps.den / fps.num;
  const srcA = join(dir, "a.mp4");
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=13",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=13",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", srcA]);
  const srcB = join(dir, "b.mp4");
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=25:d=13",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=13",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", srcB]);
  const srcC = join(dir, "c.mp4");
  await run("ffmpeg", ["-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=green:s=240x160:r=25:d=8",
    "-f", "lavfi", "-i", "color=c=magenta:s=240x160:r=25:d=8",
    "-f", "lavfi", "-i", "sine=frequency=660:duration=8",
    "-filter_complex", "[0][1]vstack,select='lt(mod(n,9),7)'[v]",
    "-map", "[v]", "-map", "2:a", "-fps_mode", "vfr",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-bsf:v", "h264_metadata=display_orientation=insert:rotate=180",
    "-c:a", "aac", "-shortest", srcC]);
  const assembly = fixtureAssembly();
  assembly.fps = fps;
  assembly.width = 320;
  assembly.height = 240;
  assembly.sources = [
    { id: "a", path: srcA, sha256: await hashFile(srcA), durationSeconds: 13, hasVideo: true, hasAudio: true, fps: { num: 25, den: 1 }, width: 320, height: 240, role: "speech", included: true, name: "a.mp4" },
    { id: "b", path: srcB, sha256: await hashFile(srcB), durationSeconds: 13, hasVideo: true, hasAudio: true, fps: { num: 25, den: 1 }, width: 320, height: 240, role: "support", included: true, name: "b.mp4" },
    { id: "c", path: srcC, sha256: await hashFile(srcC), durationSeconds: 7.9, hasVideo: true, hasAudio: true, fps: { num: 25, den: 1 }, width: 240, height: 320, role: "speech", included: true, name: "c.mp4" },
  ];
  assembly.tracks = [
    { kind: "Video", name: "V1", clips: [
      { id: "v1a", sceneId: "s", sourceId: "a", sourceStartSeconds: 0, startFrame: 0, durationFrames: 90 },
      { id: "v1b", sceneId: "s", sourceId: "c", sourceStartSeconds: 0, startFrame: 90, durationFrames: 180 },
      { id: "v1c", sceneId: "s", sourceId: "a", sourceStartSeconds: 0, startFrame: 270, durationFrames: 90 },
    ] },
    { kind: "Video", name: "V2", clips: [
      { id: "v2b", sceneId: "s", sourceId: "b", sourceStartSeconds: 0, startFrame: 120, durationFrames: 165 },
    ] },
    { kind: "Audio", name: "A1", clips: [
      { id: "a1a", sceneId: "s", sourceId: "a", sourceStartSeconds: 0, startFrame: 0, durationFrames: 360 },
    ] },
  ];
  const out = await renderAssembly(assembly, dir, new SpawnExecutor());
  const probeJson = async (args: string[]) => {
    const { stdout } = await run("ffprobe", ["-v", "error", ...args, out]);
    return stdout.trim();
  };
  // Canvas preservado apesar da entrada portrait.
  expect(await probeJson(["-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0"]))
    .toBe("h264,320,240");
  // Duração dentro de um frame e contagem exata: sem erro acumulado no concat.
  const vDur = Number(await probeJson(["-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0"]));
  expect(Math.abs(vDur - 360 * frame)).toBeLessThan(frame);
  expect(await probeJson(["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"]))
    .toBe("360");
  // Frames imediatamente antes/depois das bordas (média 1x1).
  const avgAt = async (frameNo: number) => {
    const path = join(dir, `seg-${frameNo}.rgb`);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", String(frameNo * frame), "-i", out,
      "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", path]);
    return readFile(path);
  };
  const red89 = await avgAt(89);
  expect(red89[0]).toBeGreaterThan(150);
  expect(red89[2]).toBeLessThan(80);
  for (const blue of [150, 268, 270, 284]) {
    const pixel = await avgAt(blue);
    expect(pixel[2]).toBeGreaterThan(150);
    expect(pixel[0]).toBeLessThan(80);
  }
  const red286 = await avgAt(286);
  expect(red286[0]).toBeGreaterThan(150);
  expect(red286[2]).toBeLessThan(80);
  // Portrait VFR com rotação: bandas no lugar, pillarbox escuro.
  const full91 = join(dir, "seg-91-full.rgb");
  await run("ffmpeg", ["-v", "error", "-y", "-ss", String(91 * frame), "-i", out,
    "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", full91]);
  const full = await readFile(full91);
  expect(full.length).toBe(320 * 240 * 3);
  const at = (x: number, y: number) => full.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3);
  const top = at(160, 30);
  expect(top[0]).toBeGreaterThan(150);
  expect(top[2]).toBeGreaterThan(150);
  expect(top[1]).toBeLessThan(110);
  const bottom = at(160, 210);
  expect(bottom[1]).toBeGreaterThan(70);
  expect(bottom[0]).toBeLessThan(110);
  expect(bottom[2]).toBeLessThan(110);
  const bar = at(10, 120);
  expect(bar[0]).toBeLessThan(40);
  expect(bar[1]).toBeLessThan(40);
  expect(bar[2]).toBeLessThan(40);
  // Fala contínua cruzando cortes e intervalos, sem tom do apoio nem do portrait.
  const pcm = join(dir, "voice.pcm");
  await run("ffmpeg", ["-v", "error", "-y", "-ss", "1.2", "-i", out, "-t", "3.0",
    "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", pcm]);
  const bytes = await readFile(pcm);
  const energy = (hz: number, from: number, to: number) => {
    let re = 0, im = 0;
    for (let i = from; i < to; i++) {
      const sample = bytes.readInt16LE(i * 2);
      const phase = 2 * Math.PI * hz * i / 16000;
      re += sample * Math.cos(phase);
      im += sample * Math.sin(phase);
    }
    return re * re + im * im;
  };
  const total = bytes.length / 2;
  const half = Math.floor(total / 2);
  expect(energy(440, 0, total)).toBeGreaterThan(50 * energy(880, 0, total));
  expect(energy(440, 0, total)).toBeGreaterThan(50 * energy(660, 0, total));
  const firstHalf = energy(440, 0, half);
  const secondHalf = energy(440, half, total);
  expect(firstHalf / secondHalf).toBeGreaterThan(0.25);
  expect(firstHalf / secondHalf).toBeLessThan(4);
  for (const source of assembly.sources) expect(await hashFile(source.path)).toBe(source.sha256);
}, 180_000);

it("renderAssembly aceita fontes com identidade verificada sem exigir recalculo de hash completo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-render-io-"));
  const clip = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const st = await stat(clip);
  const a = fixtureAssembly();
  a.sources[0]!.path = clip;
  a.sources[0]!.size = st.size;
  a.sources[0]!.mtimeMs = st.mtimeMs;
  a.sources[1]!.path = clip;
  a.sources[1]!.size = st.size;
  a.sources[1]!.mtimeMs = st.mtimeMs;
  const rendered = await renderAssembly(a, dir, {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  expect(rendered).toBeDefined();
});

function copyingRenderExec(): Executor & { python: number } {
  const exec: Executor & { python: number } = {
    python: 0,
    async run(call) {
      if (call.command === "python3") exec.python += 1;
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  return exec;
}

it("mesma montagem reusa prévia validada; só metadado não renderiza", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-reuse-"));
  const assembly = await assemblyWithMedia(dir);
  const exec = copyingRenderExec();
  const first = await renderAssembly(assembly, dir, exec);
  expect(exec.python).toBe(1);
  const renamed = { ...assembly, name: "outro nome", revision: 8 };
  expect(previewIdentity(renamed)).toBe(previewIdentity(assembly));
  const second = await renderAssembly(renamed, dir, exec);
  expect(exec.python).toBe(1);
  expect(await hashFile(second)).toBe(await hashFile(first));
});

it("corte efetivo invalida a prévia cacheada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-cut-"));
  const assembly = await assemblyWithMedia(dir);
  const exec = copyingRenderExec();
  await renderAssembly(assembly, dir, exec);
  const cut = structuredClone(assembly);
  cut.tracks[0]!.clips[0]!.durationFrames = 10;
  expect(previewIdentity(cut)).not.toBe(previewIdentity(assembly));
  await renderAssembly(cut, dir, exec);
  expect(exec.python).toBe(2);
});

it("perfil de hardware entra na identidade e no encode da prévia", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-hw-"));
  const assembly = await assemblyWithMedia(dir);
  expect(previewIdentity(assembly, "nvenc")).not.toBe(previewIdentity(assembly, "software"));
  const calls: { command: string; args: string[] }[] = [];
  const exec: Executor = {
    async run(call) {
      calls.push({ command: call.command, args: call.args });
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (call.command === "python3" && work) {
        await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      }
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await renderAssembly(assembly, dir, exec, { profile: "nvenc" });
  const python = calls.find((c) => c.command === "python3");
  expect(python?.args).toContain("--encoder");
  expect(python?.args[python.args.indexOf("--encoder") + 1]).toBe("h264_nvenc");
});

it("detecta hardware e encaminha o encoder comprovado para a prévia", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-detect-"));
  const assembly = await assemblyWithMedia(dir);
  const calls: { command: string; args: string[] }[] = [];
  const exec: Executor = {
    async run(call) {
      calls.push({ command: call.command, args: call.args });
      if (call.args.includes("-encoders")) {
        return {
          code: 0,
          stdout: [
            " V..... h264_nvenc          NVIDIA NVENC H.264 encoder",
            " V..... libx264             libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 Part 10",
          ].join("\n"),
          stderr: "",
        };
      }
      const out = call.args.at(-1);
      if (call.command === "ffmpeg" && out && out.endsWith(".mp4")) {
        await copyFile(join(FIXTURES, "clip.mp4"), out);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (call.command === "ffprobe" && call.args.includes("pix_fmt")) {
        return { code: 0, stdout: "yuv420p", stderr: "" };
      }
      if (call.command === "ffprobe") {
        return { code: 0, stdout: "2.000000", stderr: "" };
      }
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (call.command === "python3" && work) {
        await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      }
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await renderAssembly(assembly, dir, exec, { detectHardware: true });
  const python = calls.find((c) => c.command === "python3");
  expect(python?.args).toContain("--encoder");
  expect(python?.args[python.args.indexOf("--encoder") + 1]).toBe("h264_nvenc");
});

it("perfil de hardware diferente não reusa a prévia cacheada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-profile-"));
  const assembly = await assemblyWithMedia(dir);
  const exec = copyingRenderExec();
  await renderAssembly(assembly, dir, exec, { profile: "software" });
  await renderAssembly(assembly, dir, exec, { profile: "nvenc" });
  expect(exec.python).toBe(2);
});

it("identidade da prévia invalida cache de renderer antigo (rendererVersion 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-version-"));
  const assembly = await assemblyWithMedia(dir);
  const valid = validateAssembly(assembly);
  const base = {
    fps: valid.fps,
    width: valid.width,
    height: valid.height,
    sources: valid.sources.map((source) => ({
      id: source.id,
      sha256: source.sha256,
      included: source.included,
    })),
    tracks: valid.tracks,
    profile: "software",
  };
  const oldKey = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  const newKey = createHash("sha256")
    .update(JSON.stringify({ ...base, rendererVersion: 2 }))
    .digest("hex");
  expect(previewIdentity(assembly)).toBe(newKey);
  expect(previewIdentity(assembly)).not.toBe(oldKey);
});

it("fallback do motor publica cache identificado como software", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-preview-fallback-"));
  const assembly = await assemblyWithMedia(dir);
  const exec: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return {
        code: 0,
        stdout: `ok\n${JSON.stringify({ data: {
          fallback: true,
          requested_encoder: "h264_videotoolbox",
          effective_encoder: "libx264",
        } })}`,
        stderr: "",
      };
    },
  };
  const dest = await renderAssembly(assembly, dir, exec, { profile: "videotoolbox" });
  expect(dest).toBe(join(dir, "rev-1", "reference.mp4"));
  const sidecar = JSON.parse(await readFile(
    join(dir, "preview-cache", previewIdentity(assembly, "software"), "preview.json"),
    "utf8",
  )) as { profile: string };
  expect(sidecar.profile).toBe("software");
  await expect(access(join(
    dir, "preview-cache", previewIdentity(assembly, "videotoolbox"), "preview.json",
  ))).rejects.toThrow();
});
