import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliBench } from "./bench.ts";

describe("runCliBench", () => {
  it("recusa lote sem arquivos reais em vez de inventar jobs", async () => {
    const result = await runCliBench({
      scenario: "cold-start",
      limit: 2,
      inputs: [],
    });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/--input/);
    expect(result.output).not.toMatch(/throughput:/);
    expect(result.output).not.toMatch(/job-01/);
  });

  it("mede arquivos reais e relata a fila visível", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-bench-cli-"));
    const files = [join(dir, "a.wav"), join(dir, "b.wav"), join(dir, "c.wav")];
    await Promise.all(files.map((file) => writeFile(file, "audio")));
    const result = await runCliBench({
      scenario: "cached-artifacts",
      limit: 1,
      inputs: files,
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/batch: 3/);
    expect(result.output).toMatch(/queue limit 1 peak /);
    expect(result.output).toMatch(/processes peak 1/);
    expect(result.output).not.toMatch(/job-01|ffmpeg -benchmark|TODO|lorem/i);
  });
});
