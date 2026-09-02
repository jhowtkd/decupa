import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { detectSilence } from "./silence.ts";

describe("detectSilence", () => {
  it("acha o silêncio conhecido dentro de 30 ms", async () => {
    const silences = await detectSilence({
      input: join(FIXTURES, "tone-gap.wav"),
      thresholdDb: -40,
      minDurationMs: 200,
    });

    expect(silences).toHaveLength(1);
    expect(Math.abs(silences[0]!.startMs - TRUTH.toneGapSilence.startMs)).toBeLessThanOrEqual(30);
    expect(Math.abs(silences[0]!.endMs - TRUTH.toneGapSilence.endMs)).toBeLessThanOrEqual(30);
  });

  it("ignora silêncios menores que minDurationMs", async () => {
    const silences = await detectSilence({
      input: join(FIXTURES, "tone-gap.wav"),
      thresholdDb: -40,
      minDurationMs: 2000,
    });
    expect(silences).toEqual([]);
  });

  it("devolve lista vazia para áudio sem silêncio", async () => {
    const silences = await detectSilence({
      input: join(FIXTURES, "raw.wav"),
      thresholdDb: -40,
      minDurationMs: 200,
    });
    expect(silences).toEqual([]);
  });
});
