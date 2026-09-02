import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { energyEnvelope } from "./envelope.ts";

describe("energyEnvelope", () => {
  it("produz um quadro a cada hopMs", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    // 2600 ms / 10 ms = 260 quadros
    expect(env.hopMs).toBe(10);
    expect(env.rms.length).toBe(260);
  });

  it("marca energia ~zero dentro do silêncio conhecido", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    // silêncio em [1000, 1600) ms => quadros [100, 160)
    for (let i = 105; i < 155; i++) {
      expect(env.rms[i]).toBeLessThan(0.001);
    }
  });

  it("marca energia alta fora do silêncio", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    expect(env.rms[50]).toBeGreaterThan(0.1);
    expect(env.rms[200]).toBeGreaterThan(0.1);
  });

  it("normaliza para 0..1 em escala de amplitude", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    for (const value of env.rms) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
