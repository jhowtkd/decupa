import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOperationMetrics, summarizeReuseJournals } from "./index.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it("finds one reusable derivative in two projects and sums the measured redundant build", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-journals-"));
  dirs.push(root);
  for (const [project, atMs, durationMs] of [["one", 100, 900], ["two", 200, 1200]] as const) {
    const dir = join(root, project, ".decupa", "metrics");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "op.jsonl"), JSON.stringify({ kind: "cache", atMs, data: {
      stage: "analysis", sha256: "a".repeat(64), configKey: "b".repeat(64), outcome: "built", durationMs,
    } }) + "\n");
  }
  const result = await summarizeReuseJournals(root);
  expect(result).toMatchObject({ reusableDerivatives: 1, reuseOpportunities: 1, redundantBuilds: 1, estimatedSavingsMs: 1200 });
  expect(result.groups).toContainEqual(expect.objectContaining({ stage: "analysis", projects: 2, builds: 2 }));
});

it("reads old journals without inventing identities or modifying the journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-old-"));
  dirs.push(root);
  const dir = join(root, "old", ".decupa", "metrics");
  const metrics = createOperationMetrics({ dir });
  metrics.emit("cache", { stage: "analysis", outcome: "built" });
  await metrics.close();
  const before = await readFile(metrics.path, "utf8");
  expect(await summarizeReuseJournals(root)).toMatchObject({ ignoredCacheEvents: 1, reusableDerivatives: 0, estimatedSavingsMs: 0 });
  expect(await readFile(metrics.path, "utf8")).toBe(before);
});

it("exposes missing build observations and separates opportunities by stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "reuse-missing-build-"));
  dirs.push(root);
  for (const [index, project] of ["one", "two"].entries()) {
    const dir = join(root, project, ".decupa", "metrics");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "op.jsonl"), JSON.stringify({ kind: "cache", atMs: index + 1, data: {
      stage: "analysis", sha256: "a".repeat(64), configKey: "b".repeat(64), outcome: index === 0 ? "built" : "hit-or-shared", durationMs: index === 0 ? 900 : 300,
    } }) + "\n");
  }
  const summary = await summarizeReuseJournals(root);
  expect(summary).toMatchObject({ reuseOpportunities: 1, opportunitiesWithoutBuild: 1, estimatedSavingsMs: 0 });
  expect(summary.groups[0]).toMatchObject({ opportunitiesWithoutBuild: 1 });
  expect(summary.byStage.analysis).toMatchObject({ reusableDerivatives: 1, reuseOpportunities: 1, opportunitiesWithoutBuild: 1, estimatedSavingsMs: 0 });
  expect(summary.byStage.visual).toMatchObject({ reusableDerivatives: 0, reuseOpportunities: 0 });
});
