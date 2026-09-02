import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { extractAudio, readPcm } from "./audio.ts";
import { probe } from "./probe.ts";

describe("extractAudio", () => {
  it("extrai wav mono 16 kHz de um mp4", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-"));
    const out = join(dir, "out.wav");

    await extractAudio({ input: join(FIXTURES, "clip.mp4"), output: out });

    const info = await probe(out);
    expect(info.sampleRate).toBe(16000);
    expect(info.audioCodec).toBe("pcm_s16le");
    // O AAC do clip.mp4 declara 3,000 s no container, mas grava 130 quadros de
    // 1024 amostras (133120 ≈ 3,019 s decodificadas). Aceitamos a duração do
    // container com tolerância para o padding de fim de quadro.
    expect(info.durationMs).toBeGreaterThanOrEqual(3000);
    expect(info.durationMs).toBeLessThan(3100);
    expect((await stat(out)).size).toBeGreaterThan(0);
  });
});

describe("readPcm", () => {
  it("devolve exatamente sampleRate * duração amostras", async () => {
    // tone-gap.wav tem 2600 ms a 16 kHz => 41600 amostras
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(pcm.length).toBe(41_600);
  });

  it("tem amplitude zero dentro do silêncio conhecido", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    // silêncio em [1000, 1600) ms => amostras [16000, 25600)
    let peak = 0;
    for (let i = 16_000; i < 25_600; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(peak).toBe(0);
  });

  it("tem amplitude alta fora do silêncio", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    let peak = 0;
    for (let i = 0; i < 16_000; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(peak).toBeGreaterThan(1000);
  });
});
