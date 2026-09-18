import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(out.width).toBe(source.width);
  expect(out.height).toBe(source.height);
  expect(out.durationMs).toBeGreaterThan(0);
  expect(Math.abs((out.durationMs ?? 0) - (source.durationMs ?? 0))).toBeLessThan(1500);
  expect(proof.compared.orientation).toBe("landscape");
  expect(proof.compared.color).toMatch(/yuv420/);
  expect(proof.compared.width).toBe(source.width);
  expect(proof.compared.height).toBe(source.height);
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
