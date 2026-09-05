import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  flagsFor,
  nearestSample,
  parseVisualIndex,
  sampleLooksBadAtJoin,
  type VisualUnitFlags,
} from "./visual.ts";

const fixture = parseVisualIndex(JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ritmo.visual_index.json"), "utf8"),
));

describe("parseVisualIndex — ritmo fixture", () => {
  it("marca looks_away em unidade com look_down ≥ 50%", () => {
    const u015 = flagsFor("u015", fixture)!;
    expect(u015.looksAway).toBe(true);
    expect(u015.handOnFace).toBe(false);
    expect(u015.noFace).toBe(false);
    expect(u015.ambiguous).toBe(false);
    expect(u015.samples).toHaveLength(5);
    expect(u015.samples[0]).toEqual({
      t: 82.0,
      lookDown: true,
      lookSide: false,
      handOnFace: false,
      face: true,
    });
  });

  it("marca ambígua a unidade com look_down entre 25% e 50%", () => {
    const u020 = flagsFor("u020", fixture)!;
    expect(u020.looksAway).toBe(false);
    expect(u020.ambiguous).toBe(true);
    expect(u020.handOnFace).toBe(false);
    expect(u020.noFace).toBe(false);
  });

  it("deixa limpa a unidade sem sinal visual", () => {
    const u005 = flagsFor("u005", fixture)!;
    expect(u005.looksAway).toBe(false);
    expect(u005.handOnFace).toBe(false);
    expect(u005.noFace).toBe(false);
    expect(u005.ambiguous).toBe(false);
  });

  it("flagsFor devolve undefined para id que não está no índice", () => {
    expect(flagsFor("u999", fixture)).toBeUndefined();
  });
});

describe("parseVisualIndex — sinais", () => {
  function flags(partial: Record<string, unknown>): VisualUnitFlags {
    return parseVisualIndex({
      units: [{
        id: "u001",
        look_down_ratio: 0,
        look_side_ratio: 0,
        hand_on_face_ratio: 0,
        face_missing_ratio: 0,
        samples: [],
        ...partial,
      }],
    })[0]!;
  }

  it("look_side ≥ 50% também é looks_away", () => {
    expect(flags({ look_side_ratio: 0.5 }).looksAway).toBe(true);
  });

  it("hand_on_face ≥ 50% liga a flag", () => {
    expect(flags({ hand_on_face_ratio: 0.5 }).handOnFace).toBe(true);
  });

  it("face_missing ≥ 50% liga no_face", () => {
    expect(flags({ face_missing_ratio: 0.5 }).noFace).toBe(true);
  });

  it("recusa JSON sem units", () => {
    expect(() => parseVisualIndex({})).toThrow(/units/);
  });
});

describe("nearestSample", () => {
  const samples = [
    { t: 10.0, lookDown: false, lookSide: false, handOnFace: false, face: true },
    { t: 10.4, lookDown: true, lookSide: false, handOnFace: true, face: true },
    { t: 10.8, lookDown: false, lookSide: false, handOnFace: false, face: true },
  ];

  it("escolhe o sample mais perto do instante", () => {
    expect(nearestSample(samples, 10.45)?.t).toBe(10.4);
  });

  it("devolve undefined sem samples", () => {
    expect(nearestSample([], 1)).toBeUndefined();
  });

  it("sampleLooksBadAtJoin liga em mão, olhar baixo ou sem rosto", () => {
    expect(sampleLooksBadAtJoin(samples[1])).toBe(true);
    expect(sampleLooksBadAtJoin(samples[0])).toBe(false);
    expect(sampleLooksBadAtJoin({ t: 1, lookDown: false, lookSide: true, handOnFace: false, face: false })).toBe(true);
    expect(sampleLooksBadAtJoin(undefined)).toBe(false);
  });
});
