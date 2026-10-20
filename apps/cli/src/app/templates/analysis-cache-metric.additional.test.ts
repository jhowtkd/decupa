import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashFile, probe } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { analyzeRecipe } from "./analysis.ts";
import type { Recipe } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function recipeIn(dir: string): Promise<Recipe> {
  const path = join(dir, "private-reference.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), path);
  const info = await probe(path);
  return {
    id: "11111111-1111-4111-8111-111111111111", revision: 1, name: "private recipe name", status: "draft",
    source: { path, sha256: await hashFile(path), durationSeconds: info.durationMs / 1000 },
    analysis: { status: "pending", stage: "media" }, rules: [],
  };
}

const frameExecutor: Executor = {
  async run(call) {
    const pattern = call.args.at(-1)!;
    const seconds = Number(call.args[call.args.indexOf("-t") + 1]!);
    for (let i = 0; i < Math.ceil(seconds); i += 1) {
      await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `frame-${i}`);
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

it("journals template speech and visual cache reuse on cold and warm runs without private content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "template-cache-metric-"));
  dirs.push(dir);
  const recipe = await recipeIn(dir);
  const metricsDir = join(dir, ".decupa", "metrics");
  let speechBuilds = 0;
  let visualBuilds = 0;
  const visualClient = {
    model: "metric-test-model",
    providerKey: "https://private.example/api?key=private-provider-token",
    async send() {
      visualBuilds += 1;
      return JSON.stringify({ spans: [{ id: "v0", start: 0, end: recipe.source.durationSeconds,
        text: "private visual response", confidence: "observed", tags: [] }] });
    },
  };
  const deps = {
    workDir: join(dir, "analysis-work"), metricsDir, exec: frameExecutor,
    send: async () => JSON.stringify({ rules: [] }), modelKey: "metric-test-model",
    allowModel: true, allowVisual: true, persist: async () => {}, visualClient,
    transcribe: async () => { speechBuilds += 1; return [{ id: "s0", sourceId: recipe.id,
      start: 0, end: 1, text: "private transcript text" }]; },
  };

  await analyzeRecipe(recipe, deps, new AbortController().signal);
  await analyzeRecipe(recipe, deps, new AbortController().signal);

  expect(speechBuilds).toBe(1);
  expect(visualBuilds).toBe(1);
  const journals = await readdir(metricsDir);
  expect(journals.length).toBeGreaterThan(0);
  const journal = (await Promise.all(journals.map(file => readFile(join(metricsDir, file), "utf8")))).join("\n");
  const events = journal.split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string; data?: Record<string, unknown> });
  const caches = events.filter(event => event.kind === "cache").map(event => event.data!);
  expect(caches).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "analysis", sha256: recipe.source.sha256, outcome: "built", configKey: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: expect.any(Number) }),
    expect.objectContaining({ stage: "analysis", sha256: recipe.source.sha256, outcome: "hit", configKey: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: expect.any(Number) }),
    expect.objectContaining({ stage: "visual", sha256: recipe.source.sha256, outcome: "built", configKey: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: expect.any(Number) }),
    expect.objectContaining({ stage: "visual", sha256: recipe.source.sha256, outcome: "hit", configKey: expect.stringMatching(/^[a-f0-9]{64}$/), durationMs: expect.any(Number) }),
  ]));
  for (const stage of ["analysis", "visual"] as const) {
    const stageEvents = caches.filter(event => event.stage === stage);
    const built = stageEvents.filter(event => event.outcome === "built");
    const hits = stageEvents.filter(event => event.outcome === "hit");
    expect(built).toHaveLength(1);
    expect(hits).toHaveLength(1);
    expect(built[0]!.configKey).toBe(hits[0]!.configKey);
  }
  expect(events.some(event => event.kind === "operation-finished")).toBe(true);
  for (const privateValue of [dir, recipe.source.path, "private recipe name", "private-provider-token", "private visual response", "private transcript text"]) {
    expect(journal).not.toContain(privateValue);
  }
});

it("closes the template metrics journal on analysis failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "template-cache-error-metric-"));
  dirs.push(dir);
  const recipe = await recipeIn(dir);
  const metricsDir = join(dir, ".decupa", "metrics");
  await expect(analyzeRecipe(recipe, {
    workDir: join(dir, "analysis-work"), metricsDir, exec: frameExecutor,
    send: async () => "{}", modelKey: "test", allowModel: true, allowVisual: true,
    persist: async () => {}, transcribe: async () => { throw Error("private transcription failure"); },
    describe: async () => [],
  }, new AbortController().signal)).rejects.toThrow(/private transcription failure/);

  const journals = await readdir(metricsDir);
  expect(journals.length).toBeGreaterThan(0);
  const journal = (await Promise.all(journals.map(file => readFile(join(metricsDir, file), "utf8")))).join("\n");
  expect(journal).toContain('"kind":"operation-finished"');
  expect(journal).not.toContain(dir);
  expect(journal).not.toContain("private transcription failure");
});
