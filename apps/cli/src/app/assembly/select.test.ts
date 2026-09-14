import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, it } from "vitest";
import { SELECT_SCRIPT, selectLocalFiles } from "./select.ts";

it("não interpola input no script constante", () => {
  expect(SELECT_SCRIPT).toContain("choose file");
  expect(SELECT_SCRIPT).not.toMatch(/\$\{/);
  expect(SELECT_SCRIPT).not.toContain("process.argv");
});

it("trata cancelamento separado de falha", async () => {
  const cancelled = await selectLocalFiles(async () => ({ code: 0, stdout: "CANCEL\n", stderr: "" }));
  expect(cancelled).toEqual({ cancelled: true });
  const failed = selectLocalFiles(async () => ({ code: 1, stdout: "", stderr: "osascript exploded" }));
  await expect(failed).rejects.toThrow(/seletor falhou/);
});

it("devolve paths reais só depois de stat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-select-"));
  const file = join(dir, "clip.mp4");
  await writeFile(file, "x");
  const result = await selectLocalFiles(async () => ({ code: 0, stdout: `${file}\n`, stderr: "" }));
  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result) return;
  expect(result.paths).toHaveLength(1);
  expect(isAbsolute(result.paths[0]!)).toBe(true);
});
