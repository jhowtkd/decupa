import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startApp } from "./server.ts";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function folder(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}

it("limpeza sem chave: abre e navega local, triagem de IA responde 428 sem derrubar o servidor", async () => {
  const user = await folder("sem-chave-limpeza-"), work = await folder("sem-chave-work-");
  vi.spyOn(process, "cwd").mockReturnValue(work);
  const app = await startApp({ input: join(FIXTURES, "clip.mp4"), workDir: join(work, "work"), autoStart: false, port: 0, providerConfigDir: user, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const root = await (await fetch(base)).text();
  expect(root).toContain("visual-provider-notice"); expect(root).not.toContain("Configure a IA do Decupa");
  expect((await fetch(base + `/jobs/${app.jobId}`)).status).toBe(200);
  const triage = await fetch(base + `/jobs/${app.jobId}/triage`, { method: "POST" });
  expect(triage.status).toBe(428); expect(await triage.json()).toEqual({ error: "Configure o provedor de texto primeiro" });
  // Sem crash: o app segue respondendo depois do 428.
  expect((await fetch(base)).status).toBe(200);
});

it("limpeza sem chave: /settings abre para leitura e o first-save do texto funciona por lá", async () => {
  const user = await folder("sem-chave-settings-"), work = await folder("sem-chave-settings-work-");
  vi.spyOn(process, "cwd").mockReturnValue(work);
  const app = await startApp({ input: join(FIXTURES, "clip.mp4"), workDir: join(work, "work"), autoStart: false, port: 0, providerConfigDir: user, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  expect((await fetch(base + "/settings")).status).toBe(200);
  const state = await (await fetch(base + "/settings/state")).json() as any;
  expect(state.text.saved).toMatchObject({ configured: false });
  // Seção que não é texto continua 428 antes do first-save.
  const jev = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: '{"section":"jev","typesafe":false}' });
  expect(jev.status).toBe(428);
  // First-save sem chave nova é recusado sem gravar nada.
  const noKey = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: '{"section":"text","preset":"zai"}' });
  expect(noKey.status).toBe(400);
  const saved = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ section: "text", preset: "zai", apiKey: "first-save-key-1234567890" }) });
  expect(saved.status).toBe(200);
  const after = await saved.json() as any;
  expect(after.text.saved).toMatchObject({ configured: true, preset: "zai" });
  expect(JSON.stringify(after)).not.toContain("first-save-key-1234567890");
});

it("montagem sem chave: abre e edita local, rotas de IA respondem 428", async () => {
  const user = await folder("sem-chave-montagem-"), project = await folder("sem-chave-projeto-");
  const app = await startApp({ projectDir: project, port: 0, providerConfigDir: user, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const root = await (await fetch(base)).text();
  expect(root).toContain("visual-provider-notice"); expect(root).not.toContain("Configure a IA do Decupa");
  const current = await (await fetch(base + "/project")).json() as { project: { revision: number } };
  expect(current.project.revision).toBe(0);
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // IA: 428 explícito, sem 500 e sem furar para 402 genérico.
  expect((await post("/project/prepare", { baseRevision: 0, request: "monte" })).status).toBe(428);
  expect((await post("/project/propose", { baseRevision: 0, request: "monte" })).status).toBe(428);
  expect((await post("/project/speech-proposal", { baseRevision: 0, sourceId: "a", speechId: "b", request: "x" })).status).toBe(428);
  expect((await post("/project/template-proposal", { baseRevision: 0, templateId: null })).status).toBe(428);
  // Local: edição de briefing e canvas passam sem chave.
  const input = await post("/project/input", { baseRevision: 0, kind: "brief", text: "tema local", targetSeconds: 60 });
  expect(input.status).toBe(200);
  const revision = ((await input.json()) as { project: { revision: number } }).project.revision;
  const canvas = await post("/project/settings", { baseRevision: revision, fps: { num: 25, den: 1 }, width: 1280, height: 720 });
  expect(canvas.status).toBe(200);
});
