import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { derivativeKey, mediaKey, initializeResourceLedger, ResourceLedger } from "../resource-ledger.ts";
import { analysisKey, loadAnalysis, pruneAnalysisStore, unpinAnalysis } from "./analysis.ts";
import { fixtureAssembly } from "./fixture.ts";
import type { Source } from "./types.ts";

const tempRoots: string[] = [];
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("migrates a legacy analysis pin to the ledger, survives index loss, then unpins for TTL pruning", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-ledger-migration-"));
  tempRoots.push(root);
  const storeDir = join(root, "shared-cache");
  const projectDir = join(root, "projects", "project-1");
  await mkdir(projectDir, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  const source: Source = { ...fixtureAssembly().sources[0]!, path: join(projectDir, "source.mp4") };
  const key = analysisKey(source.sha256);
  const keyDir = join(storeDir, source.sha256, key);
  await mkdir(keyDir, { recursive: true });
  const cachedAnalysis = {
    key,
    sourceId: source.id,
    status: "ready",
    speech: [],
    visual: [],
    words: [],
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  };
  const cachePath = join(keyDir, "analysis.json");
  await writeFile(cachePath, `${JSON.stringify({
    version: "analysis-v2",
    createdAt: 1,
    analysis: cachedAnalysis,
    refs: [projectDir],
  })}\n`);

  const clock = { now: 1_000 };
  const opts = { storeDir, now: () => clock.now, ttlMs: 50 };
  await initializeResourceLedger({ root: storeDir, projectDir });
  expect((await loadAnalysis(projectDir, source, opts))?.status).toBe("ready");
  const migrated = JSON.parse(await readFile(cachePath, "utf8"));
  expect(migrated).not.toHaveProperty("refs");
  expect(migrated.analysis).toMatchObject({ key, sourceId: source.id, status: "ready" });

  const resource = derivativeKey(source.sha256, "analysis", key);
  const pinned = await (await initializeResourceLedger({ root: storeDir, projectDir })).references(resource);
  expect(pinned).toContainEqual(expect.objectContaining({ id: `project:${projectDir}`, projectDir }));
  const descriptorDir = join(storeDir, ".decupa", "reference-owners");
  expect(await (await import("node:fs/promises")).readdir(descriptorDir)).toHaveLength(1);

  await rm(join(storeDir, ".decupa", "references.json"));
  await pruneAnalysisStore(storeDir, opts);
  expect(await loadAnalysis(projectDir, source, opts)).toMatchObject({ key, status: "ready" });
  await expect(access(cachePath)).resolves.toBeUndefined();

  await unpinAnalysis(storeDir, projectDir, source);
  await pruneAnalysisStore(storeDir, opts);
  await expect(access(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await (await initializeResourceLedger({ root: storeDir, projectDir })).references(resource)).toHaveLength(0);
  expect(await (await initializeResourceLedger({ root: storeDir, projectDir })).references(mediaKey(source.sha256))).toHaveLength(0);
});

it("returns cached analysis when migrating its legacy pin hits EACCES and leaves references fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "analysis-ledger-eacces-migration-"));
  tempRoots.push(root);
  const storeDir = join(root, "shared-cache");
  const projectDir = join(root, "projects", "project-1");
  await mkdir(projectDir, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  const source: Source = { ...fixtureAssembly().sources[0]!, path: join(projectDir, "source.mp4") };
  const key = analysisKey(source.sha256);
  const cachePath = join(storeDir, source.sha256, key, "analysis.json");
  await mkdir(join(storeDir, source.sha256, key), { recursive: true });
  const cachedAnalysis = {
    key,
    sourceId: source.id,
    status: "ready",
    speech: [],
    visual: [],
    words: [],
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  };
  await writeFile(cachePath, `${JSON.stringify({
    version: "analysis-v2", createdAt: 1, analysis: cachedAnalysis, refs: [projectDir],
  })}\n`);
  const ledger = await initializeResourceLedger({ root: storeDir, projectDir });
  vi.spyOn(ResourceLedger.prototype, "addResources")
    .mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

  await expect(loadAnalysis(projectDir, source, { storeDir, now: () => 1_000, ttlMs: 50 }))
    .resolves.toMatchObject({ key, status: "ready" });
  await expect(ledger.references(derivativeKey(source.sha256, "analysis", key)))
    .rejects.toThrow(/incompleto|permission denied|EACCES/i);
});
