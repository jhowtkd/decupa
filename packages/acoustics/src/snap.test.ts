import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { energyEnvelope } from "./envelope.ts";
import { snapCut } from "./snap.ts";

describe("snapCut", () => {
  it("puxa um corte próximo para dentro do vale de silêncio", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    // 940 ms está no tom, 60 ms antes do silêncio que começa em 1000 ms
    const result = snapCut({ envelope, targetMs: 940, windowMs: 120 });

    expect(result.ms).toBeGreaterThanOrEqual(1000);
    expect(result.ms).toBeLessThanOrEqual(1060);
    expect(result.movedByMs).toBe(result.ms - 940);
  });

  it("não move quando o alvo já está no ponto mais silencioso", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const result = snapCut({ envelope, targetMs: 1300, windowMs: 120 });

    expect(Math.abs(result.movedByMs)).toBeLessThanOrEqual(10);
  });

  it("respeita a janela: nunca move mais que windowMs", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const result = snapCut({ envelope, targetMs: 500, windowMs: 100 });

    expect(Math.abs(result.movedByMs)).toBeLessThanOrEqual(100);
  });

  it("não sai dos limites do envelope", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const atStart = snapCut({ envelope, targetMs: 0, windowMs: 200 });
    const atEnd = snapCut({ envelope, targetMs: 2590, windowMs: 200 });

    expect(atStart.ms).toBeGreaterThanOrEqual(0);
    expect(atEnd.ms).toBeLessThanOrEqual(2600);
  });

  it("com alvo negativo, permanece dentro dos limites do envelope", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const result = snapCut({ envelope, targetMs: -130, windowMs: 120 });

    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.ms).toBeLessThanOrEqual(2600);
  });

  it("devolve o alvo intacto para envelope vazio", () => {
    const result = snapCut({
      envelope: { hopMs: 10, rms: new Float32Array(0) },
      targetMs: 500,
    });

    expect(result).toEqual({ ms: 500, movedByMs: 0 });
  });
});
