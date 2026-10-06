import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createVisualClient, writeCredentials } from "@decupa/triage";
import { analysisCacheDir } from "./analysis.ts";
import { fixtureAssembly } from "./fixture.ts";
import { describeSource, VISUAL_PROMPT_VERSION } from "./model.ts";
import { visualIdentityKey } from "./visual-identity.ts";

it("Montagem sem Luna reaproveita envelope e identidade visual do baseline sem chamadas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-legacy-"));
  const stored = { preset: "custom" as const, apiKey: "fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
  await writeCredentials(dir, stored);
  const source = { ...fixtureAssembly().sources[0]!, path: join(dir, "missing.mp4") };
  // Forma literal copiada do b17559e, sem usar o resolvedor novo para gravar.
  const identityKey = createHash("sha256").update(JSON.stringify({ version: "visual-v4", providerKey: stored.baseUrl,
    model: stored.model, profile: "baseline", promptVersion: 3, sampleFps: 1, frameMaxSize: 480 })).digest("hex");
  const cacheDir = join(analysisCacheDir(dir, source.sha256), `visual-v4-${identityKey}`);
  await mkdir(cacheDir, { recursive: true });
  const spans = [{ id: "a:w0:0", sourceId: "a", start: 0, end: 3, text: "cache legado", confidence: "observed", tags: [] }];
  await writeFile(join(cacheDir, "w-0-3.json"), JSON.stringify({ version: "visual-v4", sha256: source.sha256,
    promptVersion: 3, model: stored.model, providerKey: stored.baseUrl, identityKey, inputMode: "frames", sampleFps: 1,
    window: { start: 0, end: 3, fetchStart: 0 }, spans }));
  let calls = 0;
  const client = createVisualClient({ stored, env: {}, fetchImpl: async () => { calls++; throw Error("sem rede"); } });
  expect(visualIdentityKey(client, "baseline", VISUAL_PROMPT_VERSION)).toBe(identityKey);
  expect(visualIdentityKey(createVisualClient({ stored, env: {}, maxTokens: 8000 }), "baseline", VISUAL_PROMPT_VERSION)).toBe(identityKey);
  const result = await describeSource(source, dir, new AbortController().signal, {
    client, exec: { run: async () => { calls++; throw Error("sem extração"); } },
  });
  expect(result).toEqual(spans); expect(calls).toBe(0);
});
