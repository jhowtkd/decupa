import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { probe, selectFrameRate } from "./probe.ts";

describe("probe", () => {
  it("lê duração, dimensões e fps de um mp4", async () => {
    const info = await probe(join(FIXTURES, "clip.mp4"));
    expect(info.durationMs).toBe(TRUTH.clipDurationMs);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.fps).toBe(25);
    expect(info.frameRate).toEqual({ num: 25, den: 1 });
    expect(info.averageFrameRate).toEqual({ num: 25, den: 1 });
    expect(info.videoCodec).toBe("h264");
  });

  it("lê um wav mono 16 kHz sem vídeo", async () => {
    const info = await probe(join(FIXTURES, "tone-gap.wav"));
    expect(info.durationMs).toBe(TRUTH.toneGapDurationMs);
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
    expect(info.sampleRate).toBe(16000);
    expect(info.width).toBeNull();
    expect(info.frameRate).toBeNull();
    expect(info.averageFrameRate).toBeNull();
  });

  it("dá erro claro quando o arquivo não existe", async () => {
    await expect(probe("/nao/existe.mp4")).rejects.toThrow(/ffprobe falhou/);
  });
});

describe("selectFrameRate", () => {
  it("prefere r_frame_rate quando são", () => {
    expect(selectFrameRate("30/1", "30000/1001")).toEqual({ num: 30, den: 1 });
  });

  it("cai para avg quando r é 0/0", () => {
    expect(selectFrameRate("0/0", "30000/1001")).toEqual({ num: 30000, den: 1001 });
  });

  it("ignora r absurdo", () => {
    expect(selectFrameRate("600/1", "30/1")).toEqual({ num: 30, den: 1 });
    expect(selectFrameRate("600/1", "0/0")).toBeNull();
  });
});
