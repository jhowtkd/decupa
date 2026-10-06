import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCredentials } from "@decupa/triage";
import { startApp } from "./server.ts";
import { validateProvider } from "./provider-setup.ts";
import { keyProviderState } from "./provider-visual.ts";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it("valida configuração sem chamar o provedor", () => {
  expect(() => validateProvider({ preset: "custom", apiKey: "x" })).toThrow();
  expect(() => validateProvider({ preset: "gemini", apiKey: " " })).toThrow();
  expect(() => validateProvider({ preset: "custom", apiKey: "x", model: "m", baseUrl: "http://example.com" })).toThrow();
  expect(validateProvider({ preset: "gemini", apiKey: " x " })).toEqual({ preset: "gemini", apiKey: "x" });
  expect(validateProvider({ preset: "zai", apiKey: "x" })).toEqual({ preset: "zai", apiKey: "x" });
});

it("primeira abertura vazia não salva consentimento nem ativa uma chave que apareça depois", async () => {
  const dir = await mkdtemp(join(tmpdir(), "first-without-consent-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const options = { projectDir: join(dir, "project"), providerConfigDir: dir, port: 0 };
  const app = await startApp({ ...options, env: {} }); cleanup.push(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.port}/provider`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "gemini", apiKey: "text", typesafeApiKey: "", typesafe: true }) });
  expect(response.status).toBe(200); expect(await readCredentials(dir)).not.toHaveProperty("typesafe");
  await app.close();
  const next = await startApp({ ...options, env: { TYPESAFE_API_KEY: "new-env-key" } }); cleanup.push(() => next.close());
  const state = await (await fetch(`http://127.0.0.1:${next.port}/provider/keys`)).json() as ReturnType<typeof keyProviderState>;
  expect(state.jev).toMatchObject({ configured: true, enabled: false, notice: "Decisões automáticas desligadas: ative o Jev →" });
  expect(await readCredentials(dir)).not.toHaveProperty("typesafe");
});

it("primeira configuração apara só as pontas das chaves opcionais", () => {
  const fields = { preset: "zai", apiKey: "text", openaiApiKey: " \nluna-fake-key-123456789\r\n", typesafeApiKey: "\njev-fake-key-1234567890 " };
  expect(validateProvider(fields)).toMatchObject({ openaiApiKey: "luna-fake-key-123456789", typesafeApiKey: "jev-fake-key-1234567890", typesafe: true });
  for (const field of ["openaiApiKey", "typesafeApiKey"]) expect(() => validateProvider({ ...fields, [field]: "fake-key-12345\n678901234" })).toThrow();
});

it.each([
  [{ openaiApiKey: "luna-fake-key-123456789", typesafeApiKey: "jev-fake-key-1234567890", typesafe: true, visualProvider: "openai" }, "openai", null, true],
  [{ visualProvider: "openai", typesafe: true }, "text", "Chaves de IA pendentes: Luna, Jev →", false],
  [{ visualProvider: "text", typesafe: false }, "text", null, false],
] as const)("primeira abertura aceita as duas seções opcionais %j", async (fields, provider, notice, configured) => {
  const dir = await mkdtemp(join(tmpdir(), "first-keys-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const app = await startApp({ projectDir: join(dir, "project"), providerConfigDir: dir, env: {}, port: 0 }); cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`, html = await (await fetch(base)).text();
  expect(html).toContain("Análise de imagem"); expect(html).toContain("Chave da TypeSafe"); expect(html).toContain("Não usar o Jev");
  const saved = await fetch(base + "/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "gemini", apiKey: "text-secret", ...fields }) });
  expect(saved.status).toBe(200); expect(await saved.text()).not.toContain("secret");
  const state = await (await fetch(base + "/provider/keys")).json() as ReturnType<typeof keyProviderState>;
  expect(state.visual).toMatchObject({ provider, configured }); expect(state.notice).toBe(notice);
  expect(state.jev.enabled).toBe(configured);
  expect(await (await fetch(base)).text()).not.toContain("Configure a IA do Decupa");
});

it.each(["montagem", "limpeza"])("%s exige configuração, protege a chave e reutiliza em novo projeto", async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-onboarding-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const options = mode === "montagem" ? { projectDir: join(dir, "project") } : { input: join(FIXTURES, "clip.mp4"), workDir: join(dir, "work"), autoStart: false };
  const app = await startApp({ ...options, port: 0, providerConfigDir: dir, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  expect(await (await fetch(base)).text()).toContain("Configure a IA do Decupa");
  expect((await fetch(base + "/project")).status).toBe(428);
  const post = (body: unknown, origin = base) => fetch(base + "/provider", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  expect((await post({ preset: "gemini", apiKey: "" })).status).toBe(400);
  expect((await post({ preset: "gemini", apiKey: "test-secret" }, "https://evil.example")).status).toBe(403);
  const saved = await post({ preset: "gemini", apiKey: "test-secret" });
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain("test-secret");
  expect((await readCredentials(dir))?.apiKey).toBe("test-secret");
  expect((await post({ preset: "gemini", apiKey: "replacement" })).status).toBe(409);
  expect(await (await fetch(base)).text()).not.toContain("Configure a IA do Decupa");
  const next = await startApp({ projectDir: join(dir, "next"), port: 0, providerConfigDir: dir });
  cleanup.push(() => next.close());
  expect(await (await fetch(`http://127.0.0.1:${next.port}`)).text()).not.toContain("Configure a IA do Decupa");
});

it("grava credencial da empresa no boot e pula o formulário", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-company-boot-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const app = await startApp({
    projectDir: join(dir, "project"),
    port: 0,
    providerConfigDir: dir,
    env: { DECUPA_COMPANY_API_KEY: "empresa-secret" },
  });
  cleanup.push(() => app.close());
  const html = await (await fetch(`http://127.0.0.1:${app.port}`)).text();
  expect(html).not.toContain("Configure a IA do Decupa");
  expect(html).not.toContain("empresa-secret");
  expect(await readCredentials(dir)).toEqual({ preset: "zai", apiKey: "empresa-secret" });
});

it("onboarding com Z.ai lista a opção e conclui a configuração", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-onboarding-zai-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const app = await startApp({ projectDir: join(dir, "project"), port: 0, providerConfigDir: dir, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  expect(await (await fetch(base)).text()).toContain('<option value="zai">Z.ai</option>');
  const saved = await fetch(base + "/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "zai", apiKey: "test-zai-secret" }) });
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain("test-zai-secret");
  expect(await readCredentials(dir)).toEqual({ preset: "zai", apiKey: "test-zai-secret" });
  expect(await (await fetch(base)).text()).not.toContain("Configure a IA do Decupa");
});
