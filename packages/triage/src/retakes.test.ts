import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { retakeClaims } from "./retakes.ts";
import { parseSpeechIndex } from "./speech-index.ts";
import type { VisualUnitFlags } from "./visual.ts";

const fixture = parseSpeechIndex(JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ritmo.speech_index.json"), "utf8"),
));

function dropping(id: string) {
  return retakeClaims(fixture).find((c) => c.unit_ids.includes(id));
}

describe("retakeClaims — ritmo", () => {
  it("dropa u026 e aponta restated_by u027", () => {
    const c = dropping("u026");
    expect(c).toBeDefined();
    expect(c!.reason).toBe("retake");
    expect(c!.restated_by).toBe("u027");
    expect(c!.unit_ids).toEqual(["u026"]);
    expect(c!.source).toBe("mechanical");
    expect(dropping("u027")).toBeUndefined();
  });

  it("dropa u015 e aponta restated_by u016", () => {
    const c = dropping("u015");
    expect(c).toBeDefined();
    expect(c!.reason).toBe("retake");
    expect(c!.restated_by).toBe("u016");
    expect(dropping("u016")).toBeUndefined();
  });

  it("dropa u012 e aponta restated_by u013", () => {
    const c = dropping("u012");
    expect(c).toBeDefined();
    expect(c!.reason).toBe("retake");
    expect(c!.restated_by).toBe("u013");
    expect(dropping("u013")).toBeUndefined();
  });

  it("dropa u021-u023 e aponta restated_by u020 (take de depois tem ar morto)", () => {
    const c = dropping("u021");
    expect(c).toBeDefined();
    expect(c!.reason).toBe("retake");
    expect(c!.restated_by).toBe("u020");
    expect(c!.unit_ids).toEqual(["u021", "u022", "u023"]);
    expect(dropping("u020")).toBeUndefined();
  });

  it("não dropa u009/u010 só por headOverlap", () => {
    expect(dropping("u009")).toBeUndefined();
    expect(dropping("u010")).toBeUndefined();
  });

  it("dropa o bloco de recomeço u032–u037 com restated_by u038", () => {
    const c = dropping("u032");
    expect(c).toBeDefined();
    expect(c!.reason).toBe("restart_block");
    expect(c!.restated_by).toBe("u038");
    expect(c!.unit_ids).toEqual(["u032", "u033", "u034", "u035", "u036", "u037"]);
    expect(dropping("u038")).toBeUndefined();
  });
});

describe("retakeClaims — penalidade visual opcional", () => {
  const index = parseSpeechIndex({
    source_duration: 10,
    budget: { lossless_floor_seconds: 8 },
    topic_runs: [],
    units: [
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Agora vai.", has_terminal_punct: true, word_count: 2 },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai.", has_terminal_punct: true, word_count: 2 },
    ],
  });

  const badVisual = (id: string): VisualUnitFlags => ({
    id,
    looksAway: true,
    handOnFace: false,
    noFace: false,
    ambiguous: false,
    samples: [],
  });

  it("sem visual, o take de depois ganha", () => {
    const c = retakeClaims(index)[0]!;
    expect(c.unit_ids).toEqual(["u001"]);
    expect(c.restated_by).toBe("u002");
  });

  it("com looksAway no take de depois, fica o anterior", () => {
    const visual = new Map<string, VisualUnitFlags>([["u002", badVisual("u002")]]);
    const c = retakeClaims(index, visual)[0]!;
    expect(c.unit_ids).toEqual(["u002"]);
    expect(c.restated_by).toBe("u001");
  });
});
