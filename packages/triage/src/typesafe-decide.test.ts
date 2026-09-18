import { describe, expect, it } from "vitest";
import { TypeSafeClient } from "@decupa/typesafe";
import { decideWithTypeSafe } from "./typesafe-decide.ts";
import { buildEditCatalog } from "./catalog.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const KEY = "sk-typesafe-secret-do-not-log";

function index() {
  return parseSpeechIndex({
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
}

describe("decideWithTypeSafe", () => {
  it("aplica só noul acima do limiar e não manda texto privado", async () => {
    let payload: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: "jev-latest",
        answers: {
          "prefix:u001": { type: "noul", noul: 0.92 },
          "suffix:u003": { type: "noul", noul: 0.51 },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const catalog = await buildEditCatalog(index());
    const decision = await decideWithTypeSafe(catalog, new TypeSafeClient({ apiKey: KEY, fetchImpl }));
    expect(JSON.stringify(payload.state)).not.toMatch(/Tá gravando|gancho|Ficou bom/);
    expect(JSON.stringify(payload)).not.toContain(KEY);
    expect(decision.applyIds).toEqual(["prefix:u001"]);
    expect(decision.applyIds).not.toContain("suffix:u003");
  });
});
