import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { runGold } from "./gold.ts";

describe("runGold", () => {
  it("grava um arquivo de gold edit com os intervalos removidos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-gold-"));
    const outPath = join(dir, "gold.json");

    const result = await runGold({
      rawPath: join(FIXTURES, "raw.wav"),
      editedPath: join(FIXTURES, "edited.wav"),
      outPath,
    });

    expect(result.removed).toHaveLength(2);
    expect(result.rawDurationMs).toBe(6000);
    expect(result.editedDurationMs).toBe(4600);
    expect(Math.abs(result.removedMs - 1400)).toBeLessThanOrEqual(50);

    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(written.removed).toEqual(result.removed);
    expect(typeof written.generatedAt).toBe("string");
  });

  it("os intervalos batem com a verdade dentro de 25 ms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-gold-"));
    const result = await runGold({
      rawPath: join(FIXTURES, "raw.wav"),
      editedPath: join(FIXTURES, "edited.wav"),
      outPath: join(dir, "gold.json"),
    });

    for (const [i, truth] of TRUTH.removed.entries()) {
      expect(Math.abs(result.removed[i]!.startMs - truth.startMs)).toBeLessThanOrEqual(25);
      expect(Math.abs(result.removed[i]!.endMs - truth.endMs)).toBeLessThanOrEqual(25);
    }
  });

  it("avisa quando o editado é mais longo que o bruto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-gold-"));
    await expect(runGold({
      rawPath: join(FIXTURES, "edited.wav"),
      editedPath: join(FIXTURES, "raw.wav"),
      outPath: join(dir, "gold.json"),
    })).rejects.toThrow(/mais longo que o bruto/);
  });
});
