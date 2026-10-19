import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  alignEditedFiles: vi.fn(),
}));

vi.mock("@decupa/media", () => ({ probe: mocks.probe }));
vi.mock("@decupa/goldedit", () => ({ alignEditedFiles: mocks.alignEditedFiles }));

import { runGold } from "./gold.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

async function setup(removedMs: number, existing?: string) {
  const dir = await mkdtemp(join(tmpdir(), "decupa-gold-validation-"));
  tempDirs.push(dir);
  const outPath = join(dir, "gold.json");
  if (existing !== undefined) await writeFile(outPath, existing, "utf8");
  mocks.probe.mockImplementation(async (path: string) => ({ durationMs: path === "edited" ? 2000 : 3000 }));
  mocks.alignEditedFiles.mockResolvedValue([{ startMs: 0, endMs: removedMs }]);
  return { dir, outPath };
}

describe("runGold residual validation", () => {
  it.each([
    [967, "less removal"],
    [1033, "more removal"],
  ])("publishes when residual is within one 30 fps frame (%s ms, %s)", async (removedMs) => {
    const { outPath } = await setup(Number(removedMs));
    const result = await runGold({ rawPath: "raw", editedPath: "edited", outPath });
    expect(result.removedMs).toBe(removedMs);
    expect(JSON.parse(await readFile(outPath, "utf8")).removedMs).toBe(removedMs);
  });

  it.each([
    [966, "less removal"],
    [1034, "more removal"],
  ])("blocks publication when residual exceeds one frame (%s ms, %s)", async (removedMs) => {
    const { outPath } = await setup(Number(removedMs));
    await expect(runGold({ rawPath: "raw", editedPath: "edited", outPath }))
      .rejects.toThrow(/alinhamento inconclusivo.*revise o par bruto\/editado antes de publicar o gold/);
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing destination when alignment needs review", async () => {
    const original = "keep this destination intact\n";
    const { outPath } = await setup(1100, original);
    await expect(runGold({ rawPath: "raw", editedPath: "edited", outPath }))
      .rejects.toThrow(/alinhamento inconclusivo/);
    await expect(readFile(outPath, "utf8")).resolves.toBe(original);
  });
});
