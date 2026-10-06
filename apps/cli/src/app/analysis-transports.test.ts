import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createVisualClient, payloadProfileKey, writeCredentials } from "@decupa/triage";
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
// Baseline literal de d1e1c4d para o par (Muse, inputMode:"text"), travado
// no valor exato do hash sha256 de payloadProfile — ver
// packages/triage/src/payload-profile.test.ts para a reprodução isolada do
// cálculo. textKey/legacyModelKey abaixo não são recalculados pela função
// atual: comparar com um valor recalculado não provaria nada contra uma
// mudança silenciosa de ordem de campo ou de fórmula do perfil de texto.
const MUSE_TEXT_PROFILE_HASH = "a2e97954093f6e581a30007c69d6ae50690f5edac2dcf5023a062f50e670bb34";
const MUSE_TEXT_KEY_BASELINE = '["muse-spark-1.3-contributor","https://api.meta.ai/v1/chat/completions","a2e97954093f6e581a30007c69d6ae50690f5edac2dcf5023a062f50e670bb34"]';
const MUSE_LEGACY_MODEL_KEY_BASELINE = '{"model":"muse-spark-1.3-contributor","providerKey":"https://api.meta.ai/v1/chat/completions"}';

it("padrão desligado: textKey, legacyModelKey e o corpo exato enviado ao Muse ficam idênticos ao baseline d1e1c4d", async () => {
  let body: string | undefined;
  const calls: string[] = [];
  const fetchImpl = (async (url, init) => { calls.push(String(url)); body = String(init?.body); return success("{}"); }) as typeof fetch;
  const baseline = resolveAppTransports({ stored: muse, env: {}, fetchImpl });
  expect(payloadProfileKey({ model: muse.model, inputMode: "text" })).toBe(MUSE_TEXT_PROFILE_HASH);
  expect(baseline.textKey).toBe(MUSE_TEXT_KEY_BASELINE);
  expect(baseline.legacyModelKey).toBe(MUSE_LEGACY_MODEL_KEY_BASELINE);
  const content = [{ type: "text", text: "proposta" }];
  await baseline.textSend(content);
  expect(calls).toEqual([muse.baseUrl]);
  // Corpo byte a byte: nenhum campo do Sol (reasoning_effort/store/etc.) pode
  // ter vazado para o caminho do provedor de texto quando a opção está
  // desligada — o mesmo contrato do perfil "default" de sempre.
  expect(body).toBe(JSON.stringify({ model: muse.model, messages: [{ role: "user", content }], max_tokens: 16_000, response_format: { type: "json_object" } }));
});

it("DECUPA_ASSEMBLY_TEXT_PROVIDER=openai com chave: a Montagem chama o Sol com o payload exato, muda textKey e não gera legacyModelKey", async () => {
  let body: string | undefined;
  const calls: { url: string; auth: string }[] = [];
  const fetchImpl = (async (url, init) => { calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization")! }); body = String(init?.body); return success("{}"); }) as typeof fetch;
  const solEnv = { DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "sol-fake" };
  const sol = resolveAppTransports({ stored: muse, env: solEnv, fetchImpl });
  expect(sol.textKey).not.toBe(MUSE_TEXT_KEY_BASELINE);
  expect(sol.legacyModelKey).toBeUndefined();
  const content = [{ type: "text", text: "proposta" }];
  await sol.textSend(content);
  expect(calls).toEqual([{ url: "https://api.openai.com/v1/chat/completions", auth: "Bearer sol-fake" }]);
  expect(body).toBe(JSON.stringify({
    model: "gpt-6.1-sol", messages: [{ role: "user", content }],
    reasoning_effort: "medium", max_completion_tokens: 16_000, store: false, response_format: { type: "json_object" },
  }));
});

it("DECUPA_ASSEMBLY_TEXT_PROVIDER=openai sem chave falha explícito e não cai para o Muse", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return success("{}"); }) as typeof fetch;
  const sol = resolveAppTransports({ stored: muse, env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai" }, fetchImpl });
  await expect(sol.textSend([])).rejects.toThrow(/OPENAI_API_KEY/);
  expect(calls).toBe(0);
});

it("valor inválido de DECUPA_ASSEMBLY_TEXT_PROVIDER falha na subida", () => {
  expect(() => resolveAppTransports({ stored: muse, env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "sol-direto" } })).toThrow(/DECUPA_ASSEMBLY_TEXT_PROVIDER/);
});

it("voltar ao provedor de texto depois do Sol reaproveita a identidade (e o cache) do Muse", async () => {
  const fetchImpl = (async () => success("{}")) as typeof fetch;
  const sol = resolveAppTransports({ stored: muse, env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "openai", OPENAI_API_KEY: "sol-fake" }, fetchImpl });
  const backToText = resolveAppTransports({ stored: muse, env: { DECUPA_ASSEMBLY_TEXT_PROVIDER: "text" }, fetchImpl });
  expect(backToText.textKey).toBe(MUSE_TEXT_KEY_BASELINE);
  expect(backToText.legacyModelKey).toBe(MUSE_LEGACY_MODEL_KEY_BASELINE);
  expect(backToText.textKey).not.toBe(sol.textKey);
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
