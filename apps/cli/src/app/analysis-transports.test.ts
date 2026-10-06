import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVisualClient, writeCredentials } from "@decupa/triage";
import { resolveAppTransports } from "./analysis-transports.ts";
import { describeSource } from "./assembly/model.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { SpawnExecutor } from "./pipeline.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
const env = { DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "openai-fake" };
const success = (text: string) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }));
it("servidor resolve transporte e identidade juntos, sem reler o ambiente", async () => {
  const calls: { url: string; auth: string; body: any }[] = [];
  const fetchImpl = (async (url, init) => { calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization")!, body: JSON.parse(String(init?.body)) }); return success("{}"); }) as typeof fetch;
  const snapshot = { ...env };
  const transports = resolveAppTransports({ stored: muse, env: snapshot, fetchImpl });
  snapshot.OPENAI_API_KEY = "alterada";
  snapshot.DECUPA_VISUAL_PROVIDER = "invalid-after-start";
  await transports.visualClient.send([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }]);
  await transports.textSend([{ type: "text", text: "proposta JSON" }]);
  expect(calls.map(c => [c.url, c.auth, c.body.model])).toEqual([
    ["https://api.openai.com/v1/chat/completions", "Bearer openai-fake", "gpt-6-luna"],
    [muse.baseUrl, "Bearer meta-fake", muse.model],
  ]);
  expect(transports.visualClient.model).toBe(calls[0]!.body.model);
  expect(transports.visualClient.providerKey).toBe(calls[0]!.url);
  expect(transports.textKey).not.toContain("fake");
});
it("erro de chave só bloqueia a visão e não cai para Muse", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return success("{}"); }) as typeof fetch;
  const transports = resolveAppTransports({ stored: muse, env: { DECUPA_VISUAL_PROVIDER: "openai" }, fetchImpl });
  await expect(transports.visualClient.send([])).rejects.toThrow(/OPENAI_API_KEY/);
  await transports.textSend([]);
  expect(calls).toBe(1);
  expect(() => resolveAppTransports({ env: { DECUPA_VISUAL_PROVIDER: "invalid" } })).toThrow(/DECUPA_VISUAL_PROVIDER/);
});
it("primeira configuração pela tela funciona na sessão, sem reler variáveis do shell", async () => {
  let stored: typeof muse | null = null;
  const calls: string[] = [];
  const fetchImpl = (async url => { calls.push(String(url)); return success("{}"); }) as typeof fetch;
  const startupEnv: Record<string, string | undefined> = {};
  const transports = resolveAppTransports({ env: startupEnv, fetchImpl, loadStored: async () => stored });
  await expect(transports.textSend([])).rejects.toThrow(/nenhuma chave/);
  stored = muse; startupEnv.DECUPA_VISUAL_PROVIDER = "openai"; startupEnv.OPENAI_API_KEY = "must-not-be-used";
  await transports.textSend([]); await transports.visualClient.send([]);
  expect(calls).toEqual([muse.baseUrl, muse.baseUrl]);
  expect(transports.visualClient.model).toBe(muse.model);
});
it("Montagem padrão usa Luna, isola perfil e conserva IDs/fala ao trocar chave", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-assembly-"));
  await writeCredentials(dir, muse);
  const source = { ...fixtureAssembly().sources[0]!, durationSeconds: 2, path: join(dir, "fake.mp4") };
  vi.spyOn(SpawnExecutor.prototype, "run").mockImplementation(async call => {
    const pattern = call.args.at(-1)!;
    await writeFile(pattern.replace("%03d", "000"), "fake jpeg");
    await writeFile(pattern.replace("%03d", "001"), "fake jpeg");
    return { code: 0, stdout: "", stderr: "" };
  });
  const calls: string[] = [];
  const fetchImpl = (async (url) => { calls.push(String(url)); return success(JSON.stringify({ spans: [{ id: "local", start: 0, end: 2, text: "objeto", confidence: "observed", tags: [] }] })); }) as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  const signal = new AbortController().signal;
  const baseline = await describeSource(source, dir, signal);
  vi.stubEnv("DECUPA_VISUAL_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "openai-fake");
  const luna = await describeSource(source, dir, signal);
  vi.stubEnv("OPENAI_API_KEY", "another-fake");
  const replay = await describeSource(source, dir, signal);
  expect(calls).toEqual([muse.baseUrl, "https://api.openai.com/v1/chat/completions"]);
  expect(luna).toEqual(baseline); expect(replay).toEqual(luna);
  const profileChanged = createVisualClient({ env, fetchImpl, maxTokens: 8000 });
  await describeSource(source, dir, signal, { client: profileChanged, exec: new SpawnExecutor() });
  expect(calls).toHaveLength(3);
});
