import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mechanicalKeepList } from "./mechanical.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

describe("passe mecânico — ouro ritmo", () => {
  it("reproduz o keep-list gold sem visual_index e sem LLM", () => {
    const index = parseSpeechIndex(JSON.parse(
      readFileSync(join(fixtures, "ritmo.speech_index.json"), "utf8"),
    ));
    const gold = readFileSync(join(fixtures, "ritmo.keep.txt"), "utf8").trim();
    expect(mechanicalKeepList(index)).toBe(gold);
  });
});
