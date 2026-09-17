import { describe, expect, it } from "vitest";
import { parseDecisionConfig } from "@decupa/typesafe/config";
import { CircuitBreaker, routeTriage } from "./routing.ts";
import { FakeTriageModel } from "./model.ts";
import { mechanicalKeepList } from "./mechanical.ts";
import { parseSpeechIndex } from "./speech-index.ts";
import { buildUnitsBlock } from "./prompt.ts";
import type { StructureClaim } from "./claims.ts";

const speech = parseSpeechIndex({
  source_duration: 9,
  budget: { lossless_floor_seconds: 4 },
  topic_runs: [{ keyword: "tema", unit_ids: ["u002"] }],
  trim_candidates: [],
  units: [
    { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Tá gravando?", has_terminal_punct: true, word_count: 2 },
    { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O gancho do vídeo começa aqui.", has_terminal_punct: true, word_count: 6 },
    { id: "u003", index: 2, start: 6, end: 8, duration: 2, text: "Ficou bom?", has_terminal_punct: true, word_count: 2, is_question: true },
  ],
});

const preroll: StructureClaim = {
  unit_ids: ["u001"],
  reason: "preroll",
  restated_by: null,
  note: "legado",
  source: "model",
};

describe("desligamento da decisão", () => {
  it("desligar o Jev preserva o keep-list legado", async () => {
    const config = parseDecisionConfig({ mode: "off" }, { TYPESAFE_API_KEY: "x", DECUPA_TYPESAFE: "1" });
    expect(config.enabled).toBe(false);
    const model = new FakeTriageModel([preroll]);
    const result = await routeTriage({
      mode: config.mode,
      index: speech,
      model,
      unitsBlock: buildUnitsBlock(speech),
      videoPath: "clip.mp4",
      circuit: new CircuitBreaker(),
    });
    expect(result.keepList).toBe(mechanicalKeepList(speech));
    expect(result.source).toBe("legacy");
  });
});
