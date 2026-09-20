import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { probe } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { SpawnExecutor, type Executor } from "../pipeline.ts";
import { proveHardwareEncode } from "./hardware.ts";

it("prova encode em fixture real com áudio e cai para software se o hardware falhar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-hw-"));
  const input = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), input);
  const source = await probe(input);
  expect(source.hasAudio).toBe(true);
  const proof = await proveHardwareEncode(input, dir, new SpawnExecutor());
  expect(proof.fallback === true || proof.profile !== "software").toBe(true);
  const out = await probe(proof.output);
  expect(out.hasVideo).toBe(true);
  expect(out.hasAudio).toBe(true);
  expect(out.width).toBe(640);
  expect(out.height).toBe(480);
  expect(out.durationMs).toBeGreaterThan(0);
  expect(Math.abs((out.durationMs ?? 0) - (source.durationMs ?? 0))).toBeLessThan(1500);
  expect(proof.compared.orientation).toBe("landscape");
  expect(proof.compared.color).toMatch(/yuv420/);
  expect(proof.compared.width).toBe(640);
  expect(proof.compared.height).toBe(480);
  expect(proof.compared.cutPrecisionMs).toBeLessThan(250);
  expect(proof.compared.syncMs).toBeGreaterThanOrEqual(0);
  expect(proof.compared.syncMs).toBeLessThan(250);
  expect(proof.encoders.length).toBeGreaterThan(0);
  expect(proof.attempted).not.toEqual([]);
}, 60_000);

it("encode de prova não descarta o áudio com -an", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-hw-audio-"));
  const input = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), input);
  const calls: { command: string; args: string[] }[] = [];
  const exec: Executor = {
    async run(call) {
      calls.push({ command: call.command, args: call.args });
      if (call.args.includes("-encoders")) {
        return {
          code: 0,
          stdout: " V..... libx264            libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 Part 10\n",
          stderr: "",
        };
      }
      const out = call.args.at(-1);
      if (call.command === "ffmpeg" && out && out.endsWith(".mp4")) {
        await copyFile(input, out);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (call.command === "ffprobe" && call.args.includes("pix_fmt")) {
        return { code: 0, stdout: "yuv420p", stderr: "" };
      }
      if (call.command === "ffprobe") {
        return { code: 0, stdout: "2.000000", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const proof = await proveHardwareEncode(input, dir, exec);
  const encodeCall = calls.find((c) => c.command === "ffmpeg" && c.args.includes("-c:v"));
  expect(encodeCall).toBeDefined();
  expect(encodeCall!.args).not.toContain("-an");
  expect(encodeCall!.args).toContain("-c:a");
  expect(encodeCall!.args).toContain("aac");
  expect(proof.compared.syncMs).toBe(0);
});

it("prova posiciona -hwaccel antes de -i com limites de threads e saída 640px", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-hw-args-"));
  const input = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), input);
  const calls: { command: string; args: string[] }[] = [];
  const exec: Executor = {
    async run(call) {
      calls.push({ command: call.command, args: call.args });
      if (call.args.includes("-encoders")) {
        return {
          code: 0,
          stdout: " V..... h264_videotoolbox    VideoToolbox H.264 Encoder\n",
          stderr: "",
        };
      }
      const out = call.args.at(-1);
      if (call.command === "ffmpeg" && out && out.endsWith(".mp4")) {
        await copyFile(input, out);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (call.command === "ffprobe" && call.args.includes("pix_fmt")) {
        return { code: 0, stdout: "yuv420p", stderr: "" };
      }
      if (call.command === "ffprobe") {
        return { code: 0, stdout: "2.000000", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const proof = await proveHardwareEncode(input, dir, exec);
  expect(proof.profile).toBe("videotoolbox");
  expect(proof.fallback).toBe(false);
  const encodeCall = calls.find((c) => c.command === "ffmpeg" && c.args.includes("-c:v"));
  expect(encodeCall).toBeDefined();
  const args = encodeCall!.args;
  expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"));
  expect(args).toContain("-threads");
  expect(args).toContain("-filter_threads");
  const vf = args[args.indexOf("-vf") + 1] ?? "";
  expect(vf).toMatch(/640/);
  expect(args).not.toContain("-crf");
  expect(args).toContain("-b:v");
});

it("prova aprova clipe silencioso com vídeo e duração, sem exigir áudio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-hw-silent-"));
  const input = join(dir, "silent.mp4");
  const run = promisify(execFile);
  await run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", input,
  ]);
  const source = await probe(input);
  expect(source.hasVideo).toBe(true);
  expect(source.hasAudio).toBe(false);
  const proof = await proveHardwareEncode(input, dir, new SpawnExecutor());
  const out = await probe(proof.output);
  expect(out.hasVideo).toBe(true);
  expect(out.durationMs).toBeGreaterThan(0);
}, 90_000);

it("falha de hardware cai para software sem deixar parcial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-hw-fallback-"));
  const input = join(dir, "clip.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), input);
  const exec: Executor = {
    async run(call) {
      if (call.args.includes("-encoders")) {
        return {
          code: 0,
          stdout: " V..... h264_videotoolbox    VideoToolbox H.264 Encoder\n",
          stderr: "",
        };
      }
      const out = call.args.at(-1);
      if (call.command === "ffmpeg" && out && out.endsWith(".mp4")) {
        if (out.includes("hw-videotoolbox")) {
          await writeFile(out, "parcial");
          return { code: 1, stdout: "", stderr: "hw fail" };
        }
        await copyFile(input, out);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (call.command === "ffprobe" && call.args.includes("pix_fmt")) {
        return { code: 0, stdout: "yuv420p", stderr: "" };
      }
      if (call.command === "ffprobe") {
        return { code: 0, stdout: "2.000000", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const proof = await proveHardwareEncode(input, dir, exec);
  expect(proof.profile).toBe("software");
  expect(proof.fallback).toBe(true);
  expect(proof.attempted).toContain("videotoolbox");
  await expect(access(join(dir, "hw-videotoolbox.mp4"))).rejects.toThrow();
  const out = await probe(proof.output);
  expect(out.hasVideo).toBe(true);
});
