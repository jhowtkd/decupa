import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { alignEdited, alignEditedFiles } from "./align.ts";

describe("alignEdited", () => {
  const deterministicPcm = (length: number, seed: number): Int16Array => {
    let state = seed >>> 0;
    return Int16Array.from({ length }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return ((state >>> 16) & 0xffff) - 32768;
    });
  };

  it("emite exatamente a sobra final de 1000 ms no par de 3000/2000 ms", () => {
    const kept = deterministicPcm(2000, 1);
    const tail = deterministicPcm(1000, 2);

    expect(alignEdited({
      raw: Int16Array.from([...kept, ...tail]),
      edited: kept,
      sampleRate: 1000,
      searchStepSamples: 1,
    })).toEqual([{ startMs: 2000, endMs: 3000 }]);
  });

  it("detecta corte inicial a partir de zero sem viés de janela", () => {
    const removed = deterministicPcm(500, 3);
    const kept = deterministicPcm(2000, 4);

    expect(alignEdited({
      raw: Int16Array.from([...removed, ...kept]),
      edited: kept,
      sampleRate: 1000,
      searchStepSamples: 1,
    })).toEqual([{ startMs: 0, endMs: 500 }]);
  });

  it("inclui uma cauda final menor que um hop sem criar cauda falsa", () => {
    const kept = deterministicPcm(2017, 5);
    const tail = deterministicPcm(1000, 6);

    expect(alignEdited({
      raw: Int16Array.from([...kept, ...tail]),
      edited: kept,
      sampleRate: 1000,
      searchStepSamples: 1,
    })).toEqual([{ startMs: 2017, endMs: 3017 }]);
  });

  it("não detecta remoção quando PCM igual termina fora da borda do hop", () => {
    const pcm = deterministicPcm(2017, 7);
    expect(alignEdited({
      raw: pcm,
      edited: pcm,
      sampleRate: 1000,
      searchStepSamples: 1,
    })).toEqual([]);
  });

  it("combina remoções internas e a cauda em PCM de 16 kHz", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });
    const withTailRemoved = edited.slice(0, edited.length - 16_000);
    const removed = alignEdited({ raw, edited: withTailRemoved, sampleRate: 16_000 });

    expect(removed).toHaveLength(3);
    for (const [i, truth] of TRUTH.removed.entries()) {
      expect(Math.abs(removed[i]!.startMs - truth.startMs)).toBeLessThanOrEqual(25);
      expect(Math.abs(removed[i]!.endMs - truth.endMs)).toBeLessThanOrEqual(25);
    }
    expect(removed[2]).toEqual({ startMs: 5000, endMs: 6000 });
  });

  it("recupera exatamente os intervalos removidos do par sintético", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });

    const removed = alignEdited({ raw, edited });

    expect(removed).toHaveLength(2);
    for (const [i, truth] of TRUTH.removed.entries()) {
      expect(Math.abs(removed[i]!.startMs - truth.startMs)).toBeLessThanOrEqual(25);
      expect(Math.abs(removed[i]!.endMs - truth.endMs)).toBeLessThanOrEqual(25);
    }
  });

  it("preserva a duração de cada remoção", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });

    const removed = alignEdited({ raw, edited });

    expect(Math.abs((removed[0]!.endMs - removed[0]!.startMs) - 800)).toBeLessThanOrEqual(25);
    expect(Math.abs((removed[1]!.endMs - removed[1]!.startMs) - 600)).toBeLessThanOrEqual(25);
  });

  it("não acha remoção nenhuma quando os dois lados são iguais", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    expect(alignEdited({ raw, edited: raw })).toEqual([]);
  });

  it("descarta lacunas menores que minGapMs", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });

    expect(alignEdited({ raw, edited, minGapMs: 5000 })).toEqual([]);
  });

  it("alignEditedFiles produz o mesmo resultado a partir dos caminhos", async () => {
    const removed = await alignEditedFiles({
      rawPath: join(FIXTURES, "raw.wav"),
      editedPath: join(FIXTURES, "edited.wav"),
    });
    expect(removed).toHaveLength(2);
    expect(Math.abs(removed[0]!.startMs - TRUTH.removed[0]!.startMs)).toBeLessThanOrEqual(25);
  });
});
