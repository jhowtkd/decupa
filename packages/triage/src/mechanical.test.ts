import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mechanicalClaims } from "./mechanical.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const fixture = parseSpeechIndex(JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ritmo.speech_index.json"), "utf8"),
));

describe("mechanicalClaims — ritmo", () => {
  it("emite um pré-rolo u001–u004", () => {
    const preroll = mechanicalClaims(fixture).find((c) => c.reason === "preroll");
    expect(preroll?.unit_ids).toEqual(["u001", "u002", "u003", "u004"]);
    expect(preroll?.source).toBe("mechanical");
  });

  it("emite um pós-rolo u042", () => {
    const postroll = mechanicalClaims(fixture).find((c) => c.reason === "postroll");
    expect(postroll?.unit_ids).toEqual(["u042"]);
  });

  it("não reivindica o gancho u005", () => {
    expect(mechanicalClaims(fixture).some((c) => c.unit_ids.includes("u005"))).toBe(false);
  });
});

describe("mechanicalClaims — ocupação só depois de aceitar", () => {
  it("libera unidade de pré-rolo rejeitado para ar morto", () => {
    // u001/u002 são retomada (fica u002). O prefixo de cue vira u002–u003,
    // não começa na primeira unidade, e o pré-rolo falha. u003 ainda é ar morto.
    const index = parseSpeechIndex({
      source_duration: 20,
      budget: { lossless_floor_seconds: 10 },
      topic_runs: [{ keyword: "dicas", unit_ids: ["u004"] }],
      trim_candidates: [{
        id: "u003",
        seconds: 4,
        text: "calma aí",
        reasons: ["very slow (1.1 chars/s) — dead air inside the sentence"],
      }],
      units: [
        { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Agora vai.", has_terminal_punct: true, word_count: 2 },
        { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai.", has_terminal_punct: true, word_count: 2 },
        { id: "u003", index: 2, start: 6, end: 10, duration: 4, text: "calma aí", has_terminal_punct: false, word_count: 2 },
        { id: "u004", index: 3, start: 11, end: 14, duration: 3, text: "Dicas pra você parar de ser chatão nas redes sociais.", has_terminal_punct: true, word_count: 10 },
      ],
    });
    const claims = mechanicalClaims(index);
    expect(claims.some((c) => c.reason === "dead_air" && c.unit_ids.includes("u003"))).toBe(true);
  });
});
