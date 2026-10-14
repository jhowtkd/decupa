import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PROMPT_VERSION, writeCredentials } from "@decupa/triage";
import { runTriage } from "./triage.ts";
import { triageVisual } from "./triage-visual.ts";

it("inspect muda com a visão; vídeo, estrutura e densidade continuam Muse e aquecidos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-inspect-"));
  const stored = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
  await writeCredentials(dir, stored);
  const indexPath = join(dir, "speech_index.json"), videoPath = join(dir, "v.mp4"), framePath = join(dir, "frame.jpg");
  await writeFile(indexPath, JSON.stringify({ source_duration: 3, budget: { lossless_floor_seconds: 3 }, units: [{ id: "u1", index: 0, start: 0, end: 3, duration: 3, text: "Uma frase completa para preservar o conteúdo principal." }] }));
  await writeFile(videoPath, "fake video"); await writeFile(framePath, "fake jpeg");
  const calls: { url: string; kinds: string[] }[] = [];
  const fetchImpl = (async (url, init) => {
    const body = JSON.parse(String(init?.body)), parts = body.messages[0].content;
    const kinds = parts.map((part: { type: string }) => part.type);
    calls.push({ url: String(url), kinds });
    const result = kinds.includes("image_url") ? { unitId: "u1", decision: "keep", note: "observado" } : { claims: [], candidates: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }) as typeof fetch;
  const opts = { indexPath, videoPath, outDir: join(dir, "out"), projectDir: dir, targetSeconds: 2, routeMode: "off" as const, fetchImpl,
    visual: [{ id: "u1", looksAway: false, handOnFace: false, noFace: false, ambiguous: true, samples: [] }], extractFrames: async () => [framePath] };
  const initial = await runTriage({ ...opts, env: {} });
  expect(calls).toHaveLength(3); expect(calls.every(call => call.url === stored.baseUrl)).toBe(true);
  const env = { DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "fake" };
  const lunar = await runTriage({ ...opts, env });
  expect(calls).toHaveLength(4); expect(calls.at(-1)).toEqual({ url: "https://api.openai.com/v1/chat/completions", kinds: ["image_url", "text"] });
  await runTriage({ ...opts, env: { ...env, OPENAI_API_KEY: "other-fake" } });
  expect(calls).toHaveLength(4); expect(lunar.keepList).toBe(initial.keepList);
  const missing = await runTriage({ ...opts, outDir: join(dir, "missing-key"), env: { DECUPA_VISUAL_PROVIDER: "openai" } });
  expect(calls.slice(4).map(c => c.url)).toEqual([stored.baseUrl, stored.baseUrl]);
  expect(missing.reviewFlags.map(flag => flag.message)).toContain("visão: chave OpenAI ausente");
});

const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "inspect-errors-")); await writeCredentials(dir, muse);
  const indexPath = join(dir, "speech_index.json"), videoPath = join(dir, "v.mp4"), frame = join(dir, "frame.jpg");
  const index = JSON.stringify({ source_duration: 6, budget: { lossless_floor_seconds: 6 }, units: [
    { id: "u1", index: 0, start: 0, end: 3, duration: 3, text: "A primeira ideia precisa continuar inteira." },
    { id: "u2", index: 1, start: 3, end: 6, duration: 3, text: "Outra informação relevante encerra este vídeo." },
  ] });
  await writeFile(indexPath, index); await writeFile(videoPath, "video"); await writeFile(frame, "jpeg");
  return { dir, index, opts: { indexPath, videoPath, outDir: join(dir, "out"), projectDir: dir, routeMode: "off" as const,
    visual: ["u1", "u2"].map(id => ({ id, looksAway: false, handOnFace: false, noFace: false, ambiguous: true, samples: [] })),
    extractFrames: async () => [frame] } };
}

it("Limpeza usa providerId e inspectKey literais do baseline, sem transporte ou extração", async () => {
  const { index, opts } = await fixture(); let calls = 0;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const providerId = `custom|${muse.model}|${muse.baseUrl}`;
  const resolved = triageVisual({ env: {}, stored: muse, provider: "custom", modelName: muse.model, providerId });
  expect(resolved.providerId).toBe(providerId);
  expect(triageVisual({ env: {}, stored: muse, provider: "custom", modelName: muse.model, providerId, maxTokens: 8000 }).providerId).toBe(providerId);
  const dir = join(opts.outDir, "triage_cache"); await mkdir(dir, { recursive: true });
  // cacheKey do b17559e: valores separados por espaço, sem hash de perfil.
  const parts = [sha("video"), sha(index), PROMPT_VERSION, muse.model];
  await writeFile(join(dir, `${sha([...parts, "structure", providerId].join(" "))}.json`), "[]");
  for (const id of ["u1", "u2"]) await writeFile(join(dir, `${sha([...parts, "inspect", providerId, id, ""].join(" "))}.json`), JSON.stringify({ unitId: id, decision: "keep", note: "legado" }));
  const result = await runTriage({ ...opts, env: {}, extractFrames: async () => { calls++; return []; },
    fetchImpl: async () => { calls++; throw Error("sem rede"); } });
  expect(calls).toBe(0); expect(result.reviewFlags).toEqual([]);
});

it.each([401, 403, 429])("inspect HTTP %s mostra causa sem chave e evita repetir falha permanente", async status => {
  const { opts } = await fixture(); let visualCalls = 0, textCalls = 0;
  const fetchImpl = (async (url) => {
    if (String(url) === muse.baseUrl) { textCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[],"candidates":[]}' } }] })); }
    visualCalls++;
    return new Response(JSON.stringify({ error: { code: status === 429 ? "insufficient_quota" : "invalid_api_key", message: "key sk-…fake refused" } }), { status });
  }) as typeof fetch;
  const result = await runTriage({ ...opts, env: { DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "fake" }, fetchImpl });
  const message = status === 429 ? "visão: cota OpenAI esgotada" : "visão: chave OpenAI recusada";
  expect(result.reviewFlags.map(flag => flag.message)).toEqual([message, message]);
  expect(visualCalls).toBe(1); expect(textCalls).toBe(1);
});

it("Muse recebe env/fetchImpl e cancelamento de inspect interrompe antes da densidade", async () => {
  const { opts } = await fixture(); const controller = new AbortController(); const kinds: string[][] = [];
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const parts = body.messages[0].content.map((p: { type: string }) => p.type); kinds.push(parts);
    if (parts.includes("image_url")) {
      expect(init?.signal?.aborted).toBe(false); controller.abort(); expect(init?.signal?.aborted).toBe(true);
      throw controller.signal.reason;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[]}' } }] }));
  }) as typeof fetch;
  await expect(runTriage({ ...opts, targetSeconds: 2, signal: controller.signal, env: {}, fetchImpl })).rejects.toMatchObject({ name: "AbortError" });
  expect(kinds).toEqual([["video_url", "text"], ["image_url", "text"]]);
});
