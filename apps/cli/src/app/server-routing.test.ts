import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashFile, probe } from "@decupa/media";
import { writeCredentials } from "@decupa/triage";
import { TYPESAFE_ENDPOINT } from "@decupa/typesafe";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { startApp } from "./server.ts";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject } from "./assembly/store.ts";
import type { Executor } from "./pipeline.ts";
import type { Recipe } from "./templates/types.ts";

it("startApp rejeita provedor visual inválido antes de subir Montagem ou Limpeza", async () => {
  const env = { DECUPA_VISUAL_PROVIDER: "typo" };
  await expect(startApp({ projectDir: "/tmp/unused", port: 0, env })).rejects.toThrow(/DECUPA_VISUAL_PROVIDER/);
  await expect(startApp({ input: "/tmp/unused.mp4", port: 0, env, autoStart: false })).rejects.toThrow(/DECUPA_VISUAL_PROVIDER/);
});

it("app real roteia imagens ao Luna, regras/proposta ao Muse e decisões ao TypeSafe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-routing-"));
  const templatesRoot = join(dir, "templates"); const path = join(FIXTURES, "clip.mp4");
  const info = await probe(path), duration = info.durationMs / 1000;
  const muse = { preset: "custom" as const, apiKey: "meta-fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
  await writeCredentials(dir, muse);
  const project = blankProject("roteamento");
  project.assembly = { ...fixtureAssembly(), tracks: [], sources: [{ ...fixtureAssembly().sources[0]!, role: "both", path, sha256: await hashFile(path), durationSeconds: duration }] };
  await createProject(dir, project);
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const fetchImpl = (async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    if (String(url) === TYPESAFE_ENDPOINT) return new Response(JSON.stringify({ model: "jev-latest", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0 }])) }));
    const parts = body.messages[0].content;
    const result = parts.some((p: { type: string }) => p.type === "image_url")
      ? { spans: [{ id: "v", start: 0, end: duration, text: "cena", confidence: "observed", tags: [] }] }
      : parts[0].text.includes("receita editorial adaptável") ? { rules: [] }
      : { changedSceneIds: ["s"], scenes: [{ id: "s", selections: [{ speechId: "a:u1" }, { speechId: "a:u2" }], support: [], gaps: [] }],
        cutCandidates: [{ sceneId: "s", speechId: "a:u1", reason: "repetição" }], explanation: "teste" };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] }));
  }) as typeof fetch;
  const executor: Executor = { run: async call => {
    const work = call.env?.CLAUDE_PROJECT_DIR;
    if (work && call.args.includes("index")) {
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(join(work, "out", "speech_index.json"), JSON.stringify({ units: [
        { id: "u1", index: 0, start: 0, end: 1, duration: 1, text: "Uma primeira fala completa." },
        { id: "u2", index: 1, start: 1, end: 2, duration: 1, text: "A informação principal continua." },
      ] }));
    }
    const pattern = call.args.at(-1)!;
    if (pattern.includes("%03d")) for (let i = 0; i < Math.ceil(duration); i++) await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), "jpeg fake");
    return { code: 0, stdout: "", stderr: "" };
  } };
  const app = await startApp({ projectDir: dir, port: 0, templatesRoot, executor, fetchImpl,
    env: { DECUPA_VISUAL_PROVIDER: "openai", OPENAI_API_KEY: "openai-fake", DECUPA_TYPESAFE: "1", TYPESAFE_API_KEY: "jev-fake" },
    allowPaidModel: true, allowPaidVisual: true, selectFn: async () => ({ paths: [path] }),
  });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/templates/api", { name: "Referência" }); expect(created.status).toBe(201);
    const { recipe } = await created.json() as { recipe: Recipe };
    expect((await post(`/templates/api/${recipe.id}/analyze`, { baseRevision: 1 })).status).toBe(202);
    let finished: Recipe | undefined;
    for (let i = 0; i < 100; i++) {
      finished = (await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe }).recipe;
      if (finished.analysis.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(finished?.analysis, JSON.stringify(finished?.analysis)).toMatchObject({ status: "ready" });
    expect(calls.map(c => [c.url, c.body.model])).toEqual([
      ["https://api.openai.com/v1/chat/completions", "gpt-6-luna"], [muse.baseUrl, muse.model],
    ]);
    const analyzed = await post("/project/analyze", { sourceIds: ["a"], visual: true }); expect(analyzed.status).toBe(200);
    const { project: current } = await analyzed.json() as { project: { revision: number } };
    const proposed = await post("/project/propose", { baseRevision: current.revision, request: "organize as falas" }); expect(proposed.status).toBe(200);
    const result = await proposed.json() as { project: { proposal: { decisionReport: { status: string; model: string } } } };
    expect(result.project.proposal.decisionReport).toMatchObject({ status: "completed", model: "jev-latest" });
    expect(calls.filter(c => c.url === "https://api.openai.com/v1/chat/completions")).toHaveLength(2);
    expect(calls.filter(c => c.url === TYPESAFE_ENDPOINT)).toHaveLength(1);
    for (const call of calls) {
      expect(call.auth).toBe(`Bearer ${call.url === TYPESAFE_ENDPOINT ? "jev-fake" : call.url === muse.baseUrl ? "meta-fake" : "openai-fake"}`);
      if (call.body.messages) expect(call.body.messages[0].content.some((p: { type: string }) => p.type === "image_url")).toBe(call.url.includes("openai"));
    }
  } finally { await app.close(); }
});

it("startApp sem variável reutiliza o diretório de template do baseline sem chamadas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-legacy-")); const templatesRoot = join(dir, "templates");
  const muse = { preset: "custom" as const, apiKey: "fake", model: "muse-spark-1.3-contributor", baseUrl: "https://api.meta.ai/v1/chat/completions" };
  await writeCredentials(dir, muse); let calls = 0;
  const app = await startApp({ projectDir: dir, port: 0, templatesRoot, env: {},
    executor: { run: async () => { calls++; throw Error("sem processamento"); } },
    fetchImpl: async () => { calls++; throw Error("sem rede"); },
    allowPaidModel: true, allowPaidVisual: true, selectFn: async () => ({ paths: [join(FIXTURES, "clip.mp4")] }),
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const created = await fetch(base + "/templates/api", { method: "POST", body: JSON.stringify({ name: "Legado" }) });
    expect(created.status).toBe(201); const { recipe } = await created.json() as { recipe: Recipe };
    const modelKey = JSON.stringify({ model: muse.model, providerKey: muse.baseUrl });
    const key = createHash("sha256").update(JSON.stringify([recipe.source.sha256, modelKey, "recipe-v1"])).digest("hex");
    const legacy = join(templatesRoot, recipe.id, "analysis", key); await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "speech.json"), "[]"); await writeFile(join(legacy, "rules.json"), "[]");
    await writeFile(join(legacy, "visual.json"), JSON.stringify([{ id: "v", sourceId: recipe.id, start: 0,
      end: recipe.source.durationSeconds, text: "legado", confidence: "observed", tags: [] }]));
    expect((await fetch(base + `/templates/api/${recipe.id}/analyze`, { method: "POST", body: JSON.stringify({ baseRevision: 1 }) })).status).toBe(202);
    let status: string | undefined;
    for (let i = 0; i < 100; i++) {
      status = (await (await fetch(base + `/templates/api/${recipe.id}`)).json() as { recipe: Recipe }).recipe.analysis.status;
      if (status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(status).toBe("ready"); expect(calls).toBe(0);
  } finally { await app.close(); }
});
