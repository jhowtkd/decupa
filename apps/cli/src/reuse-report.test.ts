import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("reuse-report reads projects' journals through the CLI without changing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-reuse-"));
  try {
    const paths: string[] = [];
    const journals: string[] = [];
    for (const [index, project] of ["first", "second"].entries()) {
      const dir = join(root, project, ".decupa", "metrics");
      await mkdir(dir, { recursive: true });
      const path = join(dir, "test.jsonl");
      const journal = JSON.stringify({ kind: "cache", atMs: index + 1,
        data: { stage: "analysis", sha256: "a".repeat(64), configKey: "b".repeat(64), outcome: "built", durationMs: 500 + index * 100 } }) + "\n";
      await writeFile(path, journal);
      paths.push(path); journals.push(journal);
    }
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-strip-types", resolve("apps/cli/src/index.ts"), "reuse-report", "--projects-root", root,
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ reusableDerivatives: 1, reuseOpportunities: 1, estimatedSavingsMs: 600 });
    expect(stdout).not.toContain(root);
    expect(await Promise.all(paths.map(path => readFile(path, "utf8")))).toEqual(journals);
  } finally { await rm(root, { recursive: true, force: true }); }
});
