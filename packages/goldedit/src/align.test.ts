import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { alignEdited, alignEditedFiles } from "./align.ts";

describe("alignEdited", () => {
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
