import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { probe } from "@decupa/media";
import { payloadProfileKey, readCredentials, writeCredentials } from "@decupa/triage";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { startApp } from "./server.ts";
import { resolveAppTransports } from "./analysis-transports.ts";
import { sourceManifestPath } from "./session.ts";
import type { Recipe } from "./templates/types.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "settings-operation-"));
  // maxRetries/retryDelay: o coordenador de arquivos do templates/store.ts
  // (.writers) pode ainda estar liberando um lock logo após a análise virar
  // "ready" — o rm nativo já sabe reinsistir nesse tipo de corrida (ENOTEMPTY).
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })); return dir;
}
function fixedExecutor() {
  return { run: async (call: { args: string[]; env?: Record<string, string> }) => {
    const work = call.env?.CLAUDE_PROJECT_DIR;
    if (work && call.args.includes("index")) {
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(join(work, "out", "speech_index.json"), JSON.stringify({ units: [
        { id: "u1", index: 0, start: 0, end: 1, duration: 1, text: "Uma primeira fala completa." },
        { id: "u2", index: 1, start: 1, end: 2, duration: 1, text: "A informação principal continua." },
      ] }));
    }
    const pattern = call.args.at(-1)!;
    if (pattern.includes("%03d")) for (let i = 0; i < 3; i++) await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), "fake frame");
    return { code: 0, stdout: "", stderr: "" };
  } };
}
function deferredOp() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };

// Baseline literal de d1e1c4d (ver apps/cli/src/app/analysis-transports.test.ts,
// mesma dupla modelo/endpoint do Muse). Travado no valor exato — comparar com
// um valor recalculado pela função atual não provaria nada contra uma mudança
// silenciosa de fórmula ou de ordem de campo na chave de cache.
const MUSE_TEXT_KEY_BASELINE = '["muse-spark-1.3-contributor","https://api.meta.ai/v1/chat/completions","a2e97954093f6e581a30007c69d6ae50690f5edac2dcf5023a062f50e670bb34"]';

it("cache do texto: só trocar a chave do mesmo preset/endpoint mantém o cacheId igual ao baseline; trocar modelo/endpoint muda o cacheId", async () => {
  const user = await folder();
  await writeCredentials(user, muse);
  const baseline = resolveAppTransports({ stored: await readCredentials(user), env: {} });
  expect(payloadProfileKey({ model: muse.model, inputMode: "text" })).toBe("a2e97954093f6e581a30007c69d6ae50690f5edac2dcf5023a062f50e670bb34");
  expect(baseline.textKey).toBe(MUSE_TEXT_KEY_BASELINE);

  // Troca só a chave pela rota real: mesmo preset, mesmo endpoint, mesmo modelo.
  const app = await startApp({ projectDir: await folder(), port: 0, providerConfigDir: user, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (body: unknown) => fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  expect((await post({ section: "text", apiKey: "another-fake-key-1234567890" })).status).toBe(200);
  const afterKeyOnly = resolveAppTransports({ stored: await readCredentials(user), env: {} });
  expect(afterKeyOnly.textKey).toBe(MUSE_TEXT_KEY_BASELINE); // chave não entra na identidade de cache.

  // Trocar modelo/endpoint (provedor/destino) muda o cacheId, com chave nova no mesmo envio.
  expect((await post({ section: "text", apiKey: "yet-another-fake-key-123456", model: "muse-spark-2.0", baseUrl: "https://api.meta.ai/v2/chat/completions" })).status).toBe(200);
  const afterChange = resolveAppTransports({ stored: await readCredentials(user), env: {} });
  expect(afterChange.textKey).not.toBe(MUSE_TEXT_KEY_BASELINE);
});

it("ponta a ponta real (Montagem/Templates): trocar o provedor de texto pela tela (POST /settings de verdade) reaproveita o cache quando volta ao destino original, e gera chamada nova quando o destino muda", async () => {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, muse);
  const path = join(FIXTURES, "clip.mp4");
  const calls: { url: string; model: string }[] = [];
  const fetchImpl = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), model: body.model });
    const images = body.messages[0].content.some((p: { type: string }) => p.type === "image_url");
    const value = images ? { spans: [{ id: "v", start: 0, end: (await probe(path)).durationMs / 1000, text: "cena", confidence: "observed", tags: [] }] } : { rules: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] }));
  }) as typeof fetch;
  const app = await startApp({ projectDir, port: 0, templatesRoot: join(projectDir, "templates"), providerConfigDir: user, env: {},
    executor: fixedExecutor(), fetchImpl, allowPaidModel: true, allowPaidVisual: true, selectFn: async () => ({ paths: [path] }) });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });

  const created = await post("/templates/api", { name: "Referência" }); expect(created.status).toBe(201);
  const { recipe } = await created.json() as { recipe: Recipe };
  async function analyzeAndWait() {
    const current = await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe };
    expect((await post(`/templates/api/${recipe.id}/analyze`, { baseRevision: current.recipe.revision })).status).toBe(202);
    let finished: Recipe | undefined;
    for (let i = 0; i < 200; i++) {
      finished = (await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe }).recipe;
      if (finished.analysis.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return finished!;
  }

  const first = await analyzeAndWait();
  expect(first.analysis, JSON.stringify(first.analysis)).toMatchObject({ status: "ready" });
  expect(calls).toEqual([{ url: muse.baseUrl, model: muse.model }, { url: muse.baseUrl, model: muse.model }]);

  // Reanalisar sem mudar nada: mesma identidade de cache, zero chamadas novas.
  const unchanged = await analyzeAndWait();
  expect(unchanged.analysis).toMatchObject({ status: "ready" }); expect(calls).toHaveLength(2);

  // Trocar o destino pela tela de configurações de verdade (preset/endpoint e chave novos no mesmo envio).
  expect((await post("/settings", { section: "text", apiKey: "new-user-key-1234567890", model: "muse-spark-2.0", baseUrl: "https://api.meta.ai/v2/chat/completions" })).status).toBe(200);
  const changed = await analyzeAndWait();
  expect(changed.analysis).toMatchObject({ status: "ready" });
  expect(calls).toHaveLength(4); // identidade de cache mudou: visão e regras recalculam.
  expect(calls.slice(2)).toEqual([{ url: "https://api.meta.ai/v2/chat/completions", model: "muse-spark-2.0" }, { url: "https://api.meta.ai/v2/chat/completions", model: "muse-spark-2.0" }]);

  // Voltar ao destino original (chave nova de novo, a troca sempre exige): reaproveita o cache do início, sem chamada nova.
  expect((await post("/settings", { section: "text", apiKey: "back-to-original-key-123456", model: muse.model, baseUrl: muse.baseUrl })).status).toBe(200);
  const reverted = await analyzeAndWait();
  expect(reverted.analysis).toMatchObject({ status: "ready" });
  expect(calls).toHaveLength(4); // nenhuma chamada nova: o cache original (chave não entra na identidade) ainda vale.
});

it("em voo (Templates/Montagem): a análise já disparada termina com o transporte antigo em visão E regras; a próxima já usa o novo", async () => {
  const user = await folder(), projectDir = await folder();
  await writeCredentials(user, muse);
  const path = join(FIXTURES, "clip.mp4");
  const entered = deferredOp(), release = deferredOp(); let blockOnce = true;
  const calls: { url: string; model: string; auth: string | null }[] = [];
  const fetchImpl = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const auth = new Headers(init?.headers).get("authorization");
    if (blockOnce) { blockOnce = false; entered.resolve(); await release.promise; }
    calls.push({ url: String(url), model: body.model, auth });
    const images = body.messages[0].content.some((p: { type: string }) => p.type === "image_url");
    const value = images ? { spans: [{ id: "v", start: 0, end: (await probe(path)).durationMs / 1000, text: "cena", confidence: "observed", tags: [] }] } : { rules: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] }));
  }) as typeof fetch;
  const app = await startApp({ projectDir, port: 0, templatesRoot: join(projectDir, "templates"), providerConfigDir: user, env: {},
    executor: fixedExecutor(), fetchImpl, allowPaidModel: true, allowPaidVisual: true, selectFn: async () => ({ paths: [path] }) });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });

  const created = await post("/templates/api", { name: "Em voo" }); expect(created.status).toBe(201);
  const { recipe } = await created.json() as { recipe: Recipe };
  expect((await post(`/templates/api/${recipe.id}/analyze`, { baseRevision: recipe.revision })).status).toBe(202);
  await entered.promise; // o primeiro fetch (visão) já capturou o transporte do Muse e está bloqueado nele.
  expect((await post("/settings", { section: "text", apiKey: "midflight-new-key-1234567890", model: "muse-spark-2.0", baseUrl: "https://api.meta.ai/v2/chat/completions" })).status).toBe(200);
  release.resolve();
  let finished: Recipe | undefined;
  for (let i = 0; i < 200; i++) {
    finished = (await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe }).recipe;
    if (finished.analysis.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(finished?.analysis, JSON.stringify(finished?.analysis)).toMatchObject({ status: "ready" });
  // Visão e regras, as duas chamadas da operação em voo, terminaram com o Muse original.
  expect(calls).toEqual([{ url: muse.baseUrl, model: muse.model, auth: "Bearer meta-fake" }, { url: muse.baseUrl, model: muse.model, auth: "Bearer meta-fake" }]);

  const afterSwap = await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe };
  expect((await post(`/templates/api/${recipe.id}/analyze`, { baseRevision: afterSwap.recipe.revision })).status).toBe(202);
  let next: Recipe | undefined;
  for (let i = 0; i < 200; i++) {
    next = (await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe }).recipe;
    if (next.analysis.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(next?.analysis, JSON.stringify(next?.analysis)).toMatchObject({ status: "ready" });
  expect(calls).toHaveLength(4);
  // A próxima análise já usa o destino novo, nas duas chamadas (visão e regras), com a chave nova — nunca a antiga no endpoint novo.
  expect(calls.slice(2)).toEqual([
    { url: "https://api.meta.ai/v2/chat/completions", model: "muse-spark-2.0", auth: "Bearer midflight-new-key-1234567890" },
    { url: "https://api.meta.ai/v2/chat/completions", model: "muse-spark-2.0", auth: "Bearer midflight-new-key-1234567890" },
  ]);
});

it("em voo (Limpeza): a triagem real (runTriage, video_url) já disparada termina com o provedor de texto antigo em todas as chamadas; a próxima já usa o novo", async () => {
  const workDir = await folder(), cwdDir = await folder(), user = await folder();
  const video = join(workDir, "v.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), video);
  await copyFile(join(FIXTURES, "clip.mp4"), join(workDir, "triage-proxy.mp4")); // makeTriageProxy não precisa rodar ffmpeg.
  const source = await stat(video);
  await writeFile(sourceManifestPath(workDir), JSON.stringify({ path: video, size: source.size, mtimeMs: source.mtimeMs }));
  await mkdir(join(workDir, "out"), { recursive: true });
  await writeFile(join(workDir, "out", "speech_index.json"), JSON.stringify({
    source_duration: 9, budget: { lossless_floor_seconds: 4 },
    units: [
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Vamos começar pelo argumento principal.", has_terminal_punct: true, word_count: 5 },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "O ponto é este.", has_terminal_punct: true, word_count: 4 },
      { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala de jeito nenhum.", has_terminal_punct: true, word_count: 6 },
    ],
  }));
  await mkdir(join(cwdDir, ".decupa"), { recursive: true });
  await writeFile(join(cwdDir, ".decupa", "decision.json"), JSON.stringify({ mode: "off" }));
  vi.spyOn(process, "cwd").mockReturnValue(cwdDir); // fonte de projeto do texto; sem credentials ali, não sobrepõe o usuário.
  await writeCredentials(user, muse);

  const entered = deferredOp(), release = deferredOp(); let blockOnce = true;
  const calls: { url: string; model: string; auth: string | null; kinds: string[] }[] = [];
  const fetchImpl = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const kinds = (body.messages?.[0]?.content ?? []).map((part: { type: string }) => part.type);
    const auth = new Headers(init?.headers).get("authorization");
    if (blockOnce) { blockOnce = false; entered.resolve(); await release.promise; }
    calls.push({ url: String(url), model: body.model, auth, kinds });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ claims: [], candidates: [] }) } }] }));
  }) as typeof fetch;

  const app = await startApp({ input: video, workDir, autoStart: false, providerConfigDir: user, env: {}, fetchImpl, port: 0 });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;

  const first = fetch(base + `/jobs/${app.jobId}/triage`, { method: "POST" });
  await entered.promise; // o primeiro fetch da triagem (video_url) já capturou o Muse e está bloqueado nele.
  expect((await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ section: "text", apiKey: "midflight-jev-key-1234567890", model: "muse-spark-2.0", baseUrl: "https://api.meta.ai/v2/chat/completions" }) })).status).toBe(200);
  release.resolve();
  const firstResponse = await first;
  expect(firstResponse.status, JSON.stringify(await firstResponse.clone().json().catch(() => null))).toBe(200);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).toBe(muse.baseUrl); expect(call.auth).toBe(`Bearer ${muse.apiKey}`); expect(call.model).toBe(muse.model);
    expect(call.kinds).toContain("video_url");
  }
  const callsBeforeSecond = calls.length;

  const second = await fetch(base + `/jobs/${app.jobId}/triage`, { method: "POST" });
  expect(second.status).toBe(200);
  expect(calls.length).toBeGreaterThan(callsBeforeSecond); // identidade de provedor mudou: cache novo, chamada nova.
  for (const call of calls.slice(callsBeforeSecond)) {
    expect(call.url).toBe("https://api.meta.ai/v2/chat/completions"); expect(call.auth).toBe("Bearer midflight-jev-key-1234567890"); expect(call.model).toBe("muse-spark-2.0");
  }
  // Nenhum destino fora do falso: nunca Z.ai/OpenAI/TypeSafe reais, mesmo com o provedor trocado.
  expect(calls.some(c => !c.url.startsWith("https://api.meta.ai/"))).toBe(false);
});
