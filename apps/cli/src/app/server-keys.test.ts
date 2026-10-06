import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { hashFile, probe } from "@decupa/media";
import { credentialsPath, readCredentials, writeCredentials } from "@decupa/triage";
import { TYPESAFE_ENDPOINT } from "@decupa/typesafe";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { startApp } from "./server.ts";
import { keyProviderState, providerVisual } from "./provider-visual.ts";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject } from "./assembly/store.ts";
import { fillerProject } from "./assembly/filler-test-helper.ts";
import { readAssemblyFillerNotes } from "./assembly/filler-observe.ts";
import type { Executor } from "./pipeline.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const muse = { preset: "custom" as const, apiKey: "muse-secret", model: "muse", baseUrl: "https://meta.example/v1/chat/completions" };
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "server-keys-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function boot(mode = "montagem", extra: Record<string, unknown> = {}) {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, { ...muse, typesafeApiKey: "old-jev", typesafe: true });
  await writeCredentials(projectDir, { ...muse, openaiApiKey: "project-luna", visualProvider: "text", typesafeApiKey: "project-jev" });
  const app = await startApp({ ...(mode === "montagem" ? { projectDir } : { input: join(FIXTURES, "clip.mp4"), workDir: join(projectDir, "work"), autoStart: false }),
    port: 0, providerConfigDir: user, env: {}, ...extra });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (body: unknown) => fetch(base + "/provider/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, user, projectDir, base, post };
}

it.each(["montagem", "limpeza"])("%s configura as chaves sem eco, com merge, alias e limite", async mode => {
  const { user, base, post } = await boot(mode);
  const alias = await fetch(base + "/provider/visual", { redirect: "manual" });
  expect(alias.status).toBe(307); expect(alias.headers.get("location")).toBe("/provider/keys");
  const html = await (await fetch(base + "/provider/keys", { headers: { accept: "text/html" } })).text();
  expect(html).toContain("Chaves de IA"); expect(html).toContain("Chave da TypeSafe"); expect(html).toContain("Não usar o Jev");
  expect(html).not.toMatch(/muse-secret|old-jev|project-luna|project-jev/);
  const saves = await Promise.all([post({ section: "visual", visualProvider: "openai", openaiApiKey: "user-luna-fake-key-123456" }), post({ section: "jev", typesafeApiKey: "user-jev-fake-key-123456", typesafe: true })]);
  expect(saves.map(s => s.status)).toEqual([200, 200]);
  const state = await (await fetch(base + "/provider/keys")).json() as ReturnType<typeof keyProviderState>;
  expect(state.visual).toMatchObject({ provider: "openai", source: "user", configured: true, notice: null });
  expect(state.jev).toMatchObject({ enabled: true, source: "user", configured: true, notice: null });
  expect(JSON.stringify(state)).not.toMatch(/user-luna-fake-key-123456|user-jev-fake-key-123456|muse-secret|old-jev|project-/);
  expect(await readCredentials(user)).toMatchObject({ ...muse, openaiApiKey: "user-luna-fake-key-123456", visualProvider: "openai", typesafeApiKey: "user-jev-fake-key-123456", typesafe: true });
  if (process.platform !== "win32") expect((await stat(credentialsPath(user))).mode & 0o777).toBe(0o600);
  const before = await readFile(credentialsPath(user), "utf8");
  for (const invalid of [[], null, { section: "visual", visualProvider: "wrong" }, { section: "visual", visualProvider: "openai", openaiApiKey: 3 }, { section: "jev", typesafe: "true" }, { section: "jev", typesafe: true, openaiApiKey: "other" }, { section: "visual", visualProvider: "text", openaiApiKey: "x".repeat(16_384) }]) {
    const response = await post(invalid); expect(response.status).toBe(400); expect(await response.text()).not.toContain("other");
  }
  expect((await fetch(base + "/provider/keys", { method: "POST", body: "{}" })).status).toBe(400);
  expect((await fetch(base + "/provider/keys", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" })).status).toBe(400);
  expect(await readFile(credentialsPath(user), "utf8")).toBe(before);
  expect((await fetch(base + "/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(muse) })).status).toBe(409);
  expect((await post({ section: "jev", typesafe: false })).status).toBe(200);
  expect((await readCredentials(user))?.typesafe).toBe(false);
  const disabled = await (await fetch(base + "/provider/keys")).json() as ReturnType<typeof keyProviderState>;
  expect(disabled.jev).toMatchObject({ enabled: false, notice: null });
  const removedVisual = await post({ section: "visual", removeKey: true });
  expect(removedVisual.status).toBe(200); expect(await removedVisual.text()).not.toContain("user-luna-fake-key-123456");
  expect(await readCredentials(user)).toMatchObject({ ...muse, visualProvider: "openai", typesafeApiKey: "user-jev-fake-key-123456", typesafe: false });
  expect(await readCredentials(user)).not.toHaveProperty("openaiApiKey");
  const removedJev = await post({ section: "jev", removeKey: true });
  expect(removedJev.status).toBe(200); expect(await removedJev.text()).not.toContain("user-jev-fake-key-123456");
  expect(await readCredentials(user)).toEqual({ ...muse, visualProvider: "openai", typesafe: false });
  expect((await readFile(credentialsPath(user), "utf8"))).not.toMatch(/openaiApiKey|typesafeApiKey/);
});

it("validação das duas chaves aceita limites/pontas e rejeita espaços internos/controles sem eco ou escrita", async () => {
  const { user, post } = await boot();
  for (const section of ["visual", "jev"] as const) {
    const field = section === "visual" ? "openaiApiKey" : "typesafeApiKey";
    const choice = section === "visual" ? { visualProvider: "openai" } : { typesafe: true };
    for (const length of [20, 400]) expect((await post({ section, ...choice, [field]: "x".repeat(length) })).status).toBe(200);
    for (const padding of [" ", "\r\n"]) {
      const key = "fake-key-1234567890123";
      const response = await post({ section, ...choice, [field]: padding + key + padding });
      expect(response.status).toBe(200); expect(await response.text()).not.toContain(key);
      expect((await readCredentials(user))?.[field]).toBe(key);
    }
    const before = await readFile(credentialsPath(user), "utf8");
    for (const key of ["x".repeat(19), "x".repeat(401), "fake-key-12345 67890123", "fake-key-12345\n67890123", "fake-key-12345\t67890123", "fake-key-1234567890123\u0000"]) {
      const response = await post({ section, ...choice, [field]: key });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "Não foi possível salvar. Confira os campos e as permissões locais." });
    }
    expect(await readFile(credentialsPath(user), "utf8")).toBe(before);
  }
});

it("salvar e remover pela rota invalidam explicitamente antes de devolver o estado", async () => {
  const user = await folder(); await writeCredentials(user, { ...muse, typesafe: true, typesafeApiKey: "stored-key" });
  let cached = await readCredentials(user);
  const invalidateStored = vi.fn((dir: string) => { expect(dir).toBe(user); cached = null; });
  const loadStored = async () => cached ??= await readCredentials(user);
  const server = createServer((req, res) => { void providerVisual(req, res, { dir: user, env: {}, loadStored, invalidateStored }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) => fetch(base + "/provider/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(cached?.typesafe).toBe(true);
  const saved = await post({ section: "jev", typesafe: false });
  expect(saved.status).toBe(200); expect((await saved.json() as ReturnType<typeof keyProviderState>).jev.enabled).toBe(false);
  expect(invalidateStored).toHaveBeenCalledTimes(1);
  const removed = await post({ section: "jev", removeKey: true });
  expect(removed.status).toBe(200); expect((await removed.json() as ReturnType<typeof keyProviderState>).jev.configured).toBe(false);
  expect(invalidateStored).toHaveBeenCalledTimes(2); expect(cached).not.toHaveProperty("typesafeApiKey");
});

it.each(["montagem", "limpeza"])("%s exige texto antes das chaves e não persiste OPENAI_API_KEY na subida", async mode => {
  for (const configured of [false, true]) {
    const user = await folder(), project = await folder();
    vi.spyOn(process, "cwd").mockReturnValue(project);
    if (configured) await writeCredentials(user, muse);
    const before = await readFile(credentialsPath(user), "utf8").catch(() => null);
    const app = await startApp({ ...(mode === "montagem" ? { projectDir: project } : { input: join(FIXTURES, "clip.mp4"), workDir: project, autoStart: false }), port: 0, providerConfigDir: user, env: { OPENAI_API_KEY: "environment-secret-key-12345" } });
    cleanup.push(() => app.close()); const base = `http://127.0.0.1:${app.port}`;
    if (configured) {
      const response = await fetch(base + "/provider/keys"); expect(response.status).toBe(200);
      expect((await response.json() as ReturnType<typeof keyProviderState>).visual).toMatchObject({ provider: "openai", source: "environment", configured: true });
    } else {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(base + "/provider/keys", { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: '{"section":"jev","typesafe":false}' } : {}) });
        expect(response.status).toBe(428); expect(await response.json()).toEqual({ error: "Configure o provedor de texto primeiro" });
      }
    }
    expect(await readFile(credentialsPath(user), "utf8").catch(() => null)).toBe(before);
    await app.close();
  }
});

it.each(["ambiente", "credencial antiga"])("Jev com chave só no %s não dispara notas sem consentimento", async source => {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, { ...muse, ...(source === "credencial antiga" ? { typesafeApiKey: "legacy-key" } : {}) });
  await createProject(projectDir, fillerProject("é"));
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw Error("chamada sem consentimento"); });
  const app = await startApp({ projectDir, providerConfigDir: user, port: 0, env: source === "ambiente" ? { TYPESAFE_API_KEY: "environment-key" } : {}, fetchImpl }); cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  await fetch(base + "/project");
  const state = await (await fetch(base + "/provider/keys")).json() as ReturnType<typeof keyProviderState>;
  expect(state.jev).toMatchObject({ configured: true, enabled: false, notice: "Decisões automáticas desligadas: ative o Jev →" });
  expect(state.notice).toContain("ative o Jev");
  expect((await readCredentials(user))?.typesafe).toBeUndefined(); expect(fetchImpl).not.toHaveBeenCalled();
});

it.each(["montagem", "limpeza"])("%s mostra um banner combinado e o remove pelas escolhas explícitas", async mode => {
  const user = await folder(), project = await folder(); await writeCredentials(user, muse);
  const app = await startApp({ ...(mode === "montagem" ? { projectDir: project } : { input: join(FIXTURES, "clip.mp4"), workDir: project, autoStart: false }), port: 0, providerConfigDir: user, env: {} });
  cleanup.push(() => app.close()); const base = `http://127.0.0.1:${app.port}`;
  const page = await (await fetch(base)).text();
  expect(page.match(/<aside id="visual-provider-notice"/g)).toHaveLength(1);
  expect(page).toContain("Chaves de IA pendentes: Luna, Jev →");
  for (const fields of [{ section: "visual", visualProvider: "text" }, { section: "jev", typesafe: false }]) {
    expect((await fetch(base + "/provider/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) })).status).toBe(200);
  }
  expect(await (await fetch(base)).text()).toContain('id="visual-provider-notice" role="status" hidden');
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function sourceProject(dir: string) {
  const path = join(FIXTURES, "clip.mp4"), info = await probe(path), duration = info.durationMs / 1000;
  const project = blankProject("chaves");
  project.assembly = { ...fixtureAssembly(), tracks: [], sources: [{ ...fixtureAssembly().sources[0]!, role: "both", path, sha256: await hashFile(path), durationSeconds: duration }] };
  await createProject(dir, project); return duration;
}
function executor(onFrames?: () => Promise<void>): Executor {
  return { run: async call => {
    const work = call.env?.CLAUDE_PROJECT_DIR;
    if (work && call.args.includes("index")) {
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(join(work, "out", "speech_index.json"), JSON.stringify({ units: [
        { id: "u1", index: 0, start: 0, end: 1, duration: 1, text: "Uma primeira fala completa." },
        { id: "u2", index: 1, start: 1, end: 2, duration: 1, text: "A informação principal continua." },
      ] }));
    }
    const pattern = call.args.at(-1)!;
    if (pattern.includes("%03d")) { await onFrames?.(); for (let i = 0; i < 5; i++) await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), "fake jpeg"); }
    return { code: 0, stdout: "", stderr: "" };
  } };
}
function completion(body: unknown) { return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(body) } }] })); }

it("Não usar o Jev cancela notas da Montagem e descarta uma resposta que ignora abort", async () => {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, { ...muse, typesafeApiKey: "stored-jev", typesafe: true });
  await createProject(projectDir, fillerProject("é"));
  const entered = deferred(), release = deferred(), returned = deferred(); let signal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init?.signal; entered.resolve(); await release.promise;
    const body = JSON.parse(String(init?.body)); returned.resolve();
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.9 }])) }));
  });
  const app = await startApp({ projectDir, providerConfigDir: user, env: {}, port: 0, fetchImpl }); cleanup.push(() => app.close());
  cleanup.push(async () => { release.resolve(); });
  const base = `http://127.0.0.1:${app.port}`;
  expect((await fetch(base + "/project")).status).toBe(200); await entered.promise;
  const disabled = await fetch(base + "/provider/keys", { method: "POST", headers: { "content-type": "application/json" }, body: '{"section":"jev","typesafe":false}' });
  expect(disabled.status).toBe(200); expect(signal?.aborted).toBe(true);
  release.resolve(); await returned.promise;
  await vi.waitFor(async () => {
    const state = await (await fetch(base + "/project")).json() as any;
    expect(state.fillerReport.pending).toBe(false);
    expect(state.fillerReport.occurrences.every((o: any) => !o.note)).toBe(true);
  });
  expect(await readAssemblyFillerNotes(projectDir)).toBeNull(); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("troca de Luna captura transporte/cache antes dos frames e reaproveita fala e cache do texto", async () => {
  const user = await folder(), projectDir = await folder(); await writeCredentials(user, muse);
  await writeCredentials(projectDir, { ...muse, visualProvider: "text", openaiApiKey: "project-key" });
  const duration = await sourceProject(projectDir), entered = deferred(), release = deferred();
  const calls: { url: string; auth: string | null; model: string }[] = []; let block = true;
  const fetchImpl = (async (url, init) => { const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), model: body.model }); return completion({ spans: [{ id: "v", start: 0, end: duration, text: "cena", confidence: "observed", tags: [] }] }); }) as typeof fetch;
  const exec = executor(async () => { if (block) { block = false; entered.resolve(); await release.promise; } });
  const run = vi.spyOn(exec, "run");
  const app = await startApp({ projectDir, providerConfigDir: user, env: {}, port: 0, executor: exec, fetchImpl, allowPaidVisual: true }); cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const active = post("/project/analyze", { sourceIds: ["a"], visual: true }); await entered.promise;
  expect((await post("/provider/keys", { section: "visual", visualProvider: "openai", openaiApiKey: "user-key-fake-openai-123456" })).status).toBe(200);
  release.resolve(); expect((await active).status).toBe(200);
  expect(calls).toEqual([{ url: muse.baseUrl, auth: "Bearer muse-secret", model: muse.model }]);
  const indexing = () => run.mock.calls.filter(([call]) => call.args.includes("index")).length;
  const before = indexing();
  expect((await post("/project/analyze", { sourceIds: ["a"], visual: true })).status).toBe(200);
  expect(calls.at(-1)).toEqual({ url: "https://api.openai.com/v1/chat/completions", auth: "Bearer user-key-fake-openai-123456", model: "gpt-6-luna" });
  expect(indexing()).toBe(before);
  expect((await post("/provider/keys", { section: "visual", visualProvider: "text" })).status).toBe(200);
  expect((await post("/project/analyze", { sourceIds: ["a"], visual: true })).status).toBe(200);
  expect(calls).toHaveLength(2); expect(indexing()).toBe(before);
});

it("salvar Jev muda a próxima proposta e desligar conserva uma proposta já em andamento", async () => {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, { ...muse, typesafe: true, typesafeApiKey: "old-user" });
  await writeCredentials(projectDir, { ...muse, typesafe: true, typesafeApiKey: "project-jev" });
  await sourceProject(projectDir);
  const entered = deferred(), release = deferred(); let block = true; const jevKeys: string[] = [];
  const fetchImpl = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url) === TYPESAFE_ENDPOINT) { jevKeys.push(new Headers(init?.headers).get("authorization")!); return new Response(JSON.stringify({ model: "jev-latest", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0 }])) })); }
    if (block) { block = false; entered.resolve(); await release.promise; }
    return completion({ changedSceneIds: ["s"], scenes: [{ id: "s", selections: [{ speechId: "a:u1" }, { speechId: "a:u2" }], support: [], gaps: [] }], cutCandidates: [{ sceneId: "s", speechId: "a:u1", reason: "repetição" }], explanation: "teste" });
  }) as typeof fetch;
  const app = await startApp({ projectDir, providerConfigDir: user, env: {}, port: 0, executor: executor(), fetchImpl, allowPaidModel: true }); cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/project/analyze", { sourceIds: ["a"], visual: false })).status).toBe(200);
  const propose = async () => { const current = await (await fetch(base + "/project")).json() as { project: { revision: number } }; return post("/project/propose", { baseRevision: current.project.revision, request: "organize" }); };
  const active = propose(); await entered.promise;
  expect((await post("/provider/keys", { section: "jev", typesafeApiKey: "new-user-fake-jev-123456", typesafe: true })).status).toBe(200);
  release.resolve(); expect((await active).status).toBe(200); expect(jevKeys).toEqual(["Bearer old-user"]);
  expect((await propose()).status).toBe(200); expect(jevKeys).toEqual(["Bearer old-user", "Bearer new-user-fake-jev-123456"]);
  expect((await post("/provider/keys", { section: "jev", typesafe: false })).status).toBe(200);
  expect((await propose()).status).toBe(200); expect(jevKeys).toHaveLength(2);
});
