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
