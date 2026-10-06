import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { envWithStoredTypeSafe, writeCredentials } from "@decupa/triage";
import { cleanupFixture } from "./cleanup-fillers.test-helper.ts";
import { startApp } from "./server.ts";
import { createAssemblyDecisionContext } from "./assembly/assembly-decisions.ts";
import { keyProviderState } from "./provider-visual.ts";
import { triageIdentity, type TriageOptions } from "../triage.ts";

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });

it("Não usar o Jev cancela notas da Limpeza sem publicar a resposta tardia ou refazer o plano", async () => {
  const f = await cleanupFixture(true, { ambiguous: true }); await f.app.close();
  close.push(() => rm(f.dir, { recursive: true, force: true }));
  const user = join(f.dir, "user"); await mkdir(user);
  await writeCredentials(user, { preset: "zai", apiKey: "text", typesafe: true, typesafeApiKey: "stored-jev" });
  let release!: () => void, entered!: () => void, signal: AbortSignal | null | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), dispatched = new Promise<void>(resolve => { entered = resolve; });
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init?.signal; entered(); await gate;
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.9 }])) }));
  });
  const app = await startApp({ ...f.options, providerConfigDir: user, env: { VE_PLUGIN_ROOT: f.options.env.VE_PLUGIN_ROOT }, fetchImpl }); close.push(() => app.close());
  close.push(async () => { release(); });
  const base = `http://127.0.0.1:${app.port}`, job = `${base}/jobs/${app.jobId}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post(`/jobs/${app.jobId}/keep`, { keepList: "u001-u002" })).status).toBe(200); await dispatched;
  const plans = f.calls.length;
  await mkdir(join(f.configDir, ".decupa"), { recursive: true });
  await writeFile(join(f.configDir, ".decupa", "decision.json"), "broken");
  expect((await post("/provider/keys", { section: "jev", typesafe: false })).status).toBe(200);
  expect(signal?.aborted).toBe(true);
  const state = await (await fetch(job)).json() as any;
  expect(state.fillerNotesPending).toBe(false); expect(state.fillerNotes ?? []).toEqual([]);
  release(); await app.close();
  // O encerramento aguarda a tarefa cancelada, mesmo se o fetch falso ignorar abort.
  expect(await readFile(join(f.dir, "fillers-notes.json"), "utf8").catch(() => null)).toBeNull();
  expect(f.calls).toHaveLength(plans); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("salvar Jev pela tela pontua as notas pendentes na mesma sessão, sem refazer o plano", async () => {
  const f = await cleanupFixture(true, { ambiguous: true }); await f.app.close();
  close.push(() => rm(f.dir, { recursive: true, force: true }));
  const user = join(f.dir, "user"); await mkdir(user);
  await writeCredentials(user, { preset: "zai", apiKey: "text" });
  await mkdir(join(f.configDir, ".decupa"));
  await writeFile(join(f.configDir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe", model: "configured-model" }));
  const calls: string[] = [];
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(new Headers(init?.headers).get("authorization")!);
    expect(body.model).toBe("configured-model");
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.7 }])) }));
  }) as typeof fetch;
  const app = await startApp({ ...f.options, providerConfigDir: user, env: { VE_PLUGIN_ROOT: f.options.env.VE_PLUGIN_ROOT }, fetchImpl }); close.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`, job = `${base}/jobs/${app.jobId}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post(`/jobs/${app.jobId}/keep`, { keepList: "u001-u002" })).status).toBe(200);
  expect((await (await fetch(job)).json() as any).fillerNotesPending).not.toBe(true); expect(calls).toEqual([]);
  const plans = f.calls.length;
  expect((await post("/provider/keys", { section: "jev", typesafe: true, typesafeApiKey: "new-ui-key-fake-jev-123456" })).status).toBe(200);
  await vi.waitFor(async () => { expect((await (await fetch(job)).json() as any).fillerNotes?.[0]?.score).toBe(0.7); });
  expect(calls).toEqual(["Bearer new-ui-key-fake-jev-123456"]); expect(f.calls).toHaveLength(plans);
});

it("Limpeza resolve triagem, notas e banner pelo cwd/usuário, ignorando configuração do workDir", async () => {
  const f = await cleanupFixture(true, { ambiguous: true }); await f.app.close();
  close.push(() => rm(f.dir, { recursive: true, force: true }));
  const user = join(f.dir, "user"); await mkdir(user);
  const text = { preset: "custom" as const, apiKey: "cwd-text", model: "muse", baseUrl: "https://meta.example/v1" };
  await writeCredentials(f.configDir, { ...text, openaiApiKey: "cwd-luna", visualProvider: "text", typesafeApiKey: "cwd-jev", typesafe: true });
  await writeCredentials(f.dir, { ...text, apiKey: "work-text", openaiApiKey: "work-luna", visualProvider: "text", typesafeApiKey: "work-jev", typesafe: false });
  await writeFile(join(f.dir, ".decupa", "decision.json"), JSON.stringify({ mode: "off", model: "from-work" }));
  await writeFile(join(f.configDir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe", model: "from-cwd" }));
  await writeCredentials(user, { preset: "zai", apiKey: "user-text", openaiApiKey: "user-luna", visualProvider: "openai", typesafeApiKey: "user-jev", typesafe: true });
  const calls: { auth: string | null; model: string }[] = [];
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ auth: new Headers(init?.headers).get("authorization"), model: body.model });
    return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.8 }])) }));
  }) as typeof fetch;
  const triageStates: ReturnType<typeof keyProviderState>[] = [], textKeys: string[] = [];
  const triageFn = async (opts: TriageOptions) => {
    const { stored } = await triageIdentity(opts); textKeys.push(stored!.apiKey!);
    triageStates.push(keyProviderState(opts.env!, stored));
    const raw = JSON.parse(await readFile(join(f.configDir, ".decupa", "decision.json"), "utf8"));
    const context = createAssemblyDecisionContext(raw, envWithStoredTypeSafe(opts.env!, stored), fetchImpl);
    await context.client?.decide({ model: context.model, state: {}, questions: { triage: { type: "noul", instructions: "teste", criteria: { true: "corte", false: "mantenha" } } } });
    return { keepList: "u001-u002" };
  };
  const app = await startApp({ ...f.options, env: { VE_PLUGIN_ROOT: f.options.env.VE_PLUGIN_ROOT }, providerConfigDir: user, fetchImpl, triageFn }); close.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`, job = `${base}/jobs/${app.jobId}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post(`/jobs/${app.jobId}/keep`, { keepList: "u001-u002" })).status).toBe(200);
  await vi.waitFor(async () => { const state = await (await fetch(job)).json() as any; expect(state.fillerNotes?.[0]).toMatchObject({ score: 0.8, model: "from-cwd" }); });
  expect((await post(`/jobs/${app.jobId}/triage`, {})).status).toBe(200);
  const state = await (await fetch(base + "/provider/keys")).json() as ReturnType<typeof keyProviderState>;
  expect(state).toEqual(triageStates[0]); expect(textKeys).toEqual(["cwd-text"]);
  expect(state.visual).toMatchObject({ provider: "openai", source: "user", configured: true });
  expect(state.jev).toMatchObject({ enabled: true, source: "user" });
  expect(await (await fetch(base)).text()).toContain('id="visual-provider-notice" role="status" hidden');
  expect(calls).toEqual([{ auth: "Bearer user-jev", model: "from-cwd" }, { auth: "Bearer user-jev", model: "from-cwd" }]);
  expect((await post("/provider/keys", { section: "jev", typesafe: false })).status).toBe(200);
  expect((await post(`/jobs/${app.jobId}/triage`, {})).status).toBe(200); expect(calls).toHaveLength(2);
  expect(triageStates[1]!.jev).toMatchObject({ enabled: false, notice: null });
  await app.close();
  await writeFile(join(f.configDir, ".decupa", "decision.json"), JSON.stringify({ mode: "observe", model: "from-env-session" }));
  const next = await startApp({ ...f.options, providerConfigDir: user, fetchImpl, env: { VE_PLUGIN_ROOT: f.options.env.VE_PLUGIN_ROOT, OPENAI_API_KEY: "env-luna", DECUPA_VISUAL_PROVIDER: "openai", TYPESAFE_API_KEY: "env-jev", DECUPA_TYPESAFE: "1" } }); close.push(() => next.close());
  const nextBase = `http://127.0.0.1:${next.port}`;
  expect((await fetch(`${nextBase}/jobs/${next.jobId}/keep`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"keepList":"u001-u002"}' })).status).toBe(200);
  await vi.waitFor(async () => { const state = await (await fetch(`${nextBase}/jobs/${next.jobId}`)).json() as any; expect(state.fillerNotes?.[0]?.model).toBe("from-env-session"); });
  expect(calls.at(-1)).toEqual({ auth: "Bearer env-jev", model: "from-env-session" });
  const envState = await (await fetch(nextBase + "/provider/keys")).json() as ReturnType<typeof keyProviderState>;
  expect(envState.visual.source).toBe("environment"); expect(envState.jev.source).toBe("environment");
});
