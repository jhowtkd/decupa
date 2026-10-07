import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAnalysisClient, credentialsPath, readCredentials, writeCredentials, type Credentials } from "@decupa/triage";
import { startApp } from "./server.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "settings-save-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function boot(stored: Credentials) {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, stored);
  const calls: { url: string; auth: string | null; model: string }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), model: JSON.parse(String(init?.body)).model });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }));
  });
  const app = await startApp({ projectDir, port: 0, providerConfigDir: user, env: {}, fetchImpl });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (fields: object) => fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ section: "text", ...fields }) });
  const raw = async () => JSON.parse(await readFile(credentialsPath(user), "utf8"));
  // Relê o arquivo depois de ambos os merges, como a próxima operação faz.
  const send = async () => createAnalysisClient({ stored: await readCredentials(user), env: {}, fetchImpl }).send([{ type: "text", text: "Teste local sem conteúdo de projeto." }]);
  return { user, post, raw, send, calls, fetchImpl };
}

it("(a) custom → gemini em branco apaga endpoint/modelo antigos após o merge, e a chave nova só vai ao Gemini", async () => {
  const { post, raw, send, calls } = await boot({ preset: "custom", apiKey: "old-muse-key", model: "muse-spark", baseUrl: "https://meta.example/v1/chat/completions",
    openaiApiKey: "preserved-openai-key", typesafeApiKey: "preserved-jev-key", typesafe: true });
  expect((await post({ preset: "gemini", apiKey: "new-gemini-key", model: "", baseUrl: "" })).status).toBe(200);
  // Confere o arquivo, não só o objeto devolvido pelo validador: o spread era a falha.
  const saved = await raw();
  await send();
  expect(calls).toEqual([{ url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", auth: "Bearer new-gemini-key", model: "gemini-2.5-flash" }]);
  expect(saved).toEqual({ preset: "gemini", apiKey: "new-gemini-key", openaiApiKey: "preserved-openai-key", typesafeApiKey: "preserved-jev-key", typesafe: true });
});

it("(b) limpar o modelo no mesmo preset remove o override do arquivo e usa o padrão", async () => {
  const { post, raw, send, calls } = await boot({ preset: "zai", apiKey: "saved-zai-key", model: "glm-custom" });
  expect((await post({ model: "" })).status).toBe(200);
  expect(await raw()).toEqual({ preset: "zai", apiKey: "saved-zai-key" });
  await send();
  expect(calls).toEqual([{ url: "https://api.z.ai/api/coding/paas/v4/chat/completions", auth: "Bearer saved-zai-key", model: "glm-5.3-flash" }]);
});

it("(c) custom com endpoint novo sem chave dá 400 e conserva o arquivo byte a byte", async () => {
  const { user, post, send, calls, fetchImpl } = await boot({ preset: "custom", apiKey: "old-muse-key", model: "muse-spark", baseUrl: "https://meta.example/v1/chat/completions" });
  const before = await readFile(credentialsPath(user), "utf8");
  const response = await post({ preset: "custom", baseUrl: "https://other.example/v1/chat/completions" });
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "Informe a chave do novo provedor" });
  expect(await readFile(credentialsPath(user), "utf8")).toBe(before);
  expect(fetchImpl).not.toHaveBeenCalled();
  await send();
  expect(calls).toEqual([{ url: "https://meta.example/v1/chat/completions", auth: "Bearer old-muse-key", model: "muse-spark" }]);
});

it("trocar só a chave do zai não fixa modelo/endpoint padrão no arquivo", async () => {
  const { post, raw } = await boot({ preset: "zai", apiKey: "old-zai-key" });
  expect((await post({ apiKey: "new-zai-key" })).status).toBe(200);
  expect(await raw()).toEqual({ preset: "zai", apiKey: "new-zai-key" });
});
