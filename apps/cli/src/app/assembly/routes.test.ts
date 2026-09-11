import { copyFile, mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { loadProject, saveProject } from "./store.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const INDEX = {
  units: [{
    id: "u001", index: 1, start: 0, end: 1, duration: 1,
    text: "olá", has_terminal_punct: true, is_question: false,
    word_count: 1, cps: 1, lead_gap: 0,
    disfluency: { hard: [], soft: [], stutter: [] },
  }],
};

function indexingExec(): Executor {
  return {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      if (work && call.args.includes("index")) {
        await mkdir(join(work, "out"), { recursive: true });
        await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
      }
      if (work) await writeFile(join(work, "reference.mp4"), "mp4");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
}

async function boot(
  selectPaths: string[] = [],
  extras: {
    executor?: Executor;
    describeClient?: { send(content: unknown[], signal?: AbortSignal): Promise<string> };
    allowPaidVisual?: boolean;
    allowPaidModel?: boolean;
    proposeSend?: (content: unknown[], signal?: AbortSignal) => Promise<string>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "assembly-routes-"));
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const app = await startApp({
    projectDir: dir,
    port: 0,
    selectFn: async () => ({ paths: selectPaths.length ? selectPaths : [clip] }),
    ...extras,
  });
  stop = app.close;
  return { app, dir, clip, base: `http://127.0.0.1:${app.port}` };
}

it("GET do projeto devolve montagem vazia", async () => {
  const { base, app } = await boot();
  const res = await fetch(`${base}/project`);
  expect(res.status).toBe(200);
  const body = await res.json() as { project: { id: string; revision: number } };
  expect(body.project.id).toBe(app.jobId);
  expect(body.project.revision).toBe(0);
});

it("POST com baseRevision antiga devolve 409 e não altera o arquivo", async () => {
  const { base } = await boot();
  const first = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, kind: "brief", text: "um", targetSeconds: 10 }),
  });
  expect(first.status).toBe(200);
  const again = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, kind: "brief", text: "dois", targetSeconds: 10 }),
  });
  expect(again.status).toBe(409);
  const current = await (await fetch(`${base}/project`)).json() as { project: { input: { text: string }; revision: number } };
  expect(current.project.input.text).toBe("um");
  expect(current.project.revision).toBe(1);
});

it("recusa Origin de outra página", async () => {
  const { base } = await boot();
  const res = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ baseRevision: 0, kind: "brief", text: "x", targetSeconds: 1 }),
  });
  expect(res.status).toBe(403);
});

it("recusa body inválido e maior que 1 MiB", async () => {
  const { base } = await boot();
  const bad = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(bad.status).toBe(400);
  const huge = await fetch(`${base}/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(1024 * 1024 + 20),
  });
  expect(huge.status).toBe(413);
});

it("recusa mídia de fonte ausente e path arbitrário", async () => {
  const { base } = await boot();
  expect((await fetch(`${base}/project/media/inexistente`)).status).toBe(404);
  expect((await fetch(`${base}/project/media/${encodeURIComponent("../secrets")}`)).status).toBe(404);
});

it("serve a página de montagem, não a de limpeza", async () => {
  const { base } = await boot();
  const html = await (await fetch(base)).text();
  expect(html).toContain("decupa · montagem");
  expect(html).not.toContain("decupa · limpar fala");
  expect(html).toContain("<video");
  expect(html).toContain("previewPlayer");
  expect(html).toContain("/project/output/");
  expect(html).toContain("download");
  expect(html).toContain("Retomar");
  expect(html).toContain("Subir");
});

it("serve a prévia em rev-N quando ainda não há export", async () => {
  const { base, dir } = await boot();
  await mkdir(join(dir, "rev-2"), { recursive: true });
  await writeFile(join(dir, "rev-2", "reference.mp4"), "preview-bytes");
  const res = await fetch(`${base}/project/output/2/mp4`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("preview-bytes");
});

it("não chama o provedor visual sem visual=true mesmo com cliente injetado", async () => {
  let called = 0;
  const { base, clip } = await boot([], {
    executor: indexingExec(),
    allowPaidVisual: true,
    describeClient: {
      async send() {
        called += 1;
        return JSON.stringify({ spans: [] });
      },
    },
  });
  const selected = await fetch(`${base}/project/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0 }),
  });
  expect(selected.status).toBe(200);
  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { assembly: { sources: { id: string }[] } };
  };
  expect(opened.project.assembly.sources[0]).toBeTruthy();
  void clip;
  const res = await fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceIds: opened.project.assembly.sources.map((s) => s.id),
      visual: false,
    }),
  });
  expect(res.status).toBe(200);
  expect(called).toBe(0);
});

it("recusa visual pago sem autorização explícita mesmo com cliente", async () => {
  const { base } = await boot([], {
    describeClient: { async send() { throw new Error("não deveria chamar"); } },
  });
  const res = await fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceIds: ["src-1"], visual: true }),
  });
  expect(res.status).toBe(402);
});

it("grava análise por arquivo e conserva a primeira se a segunda falha", async () => {
  const clipB = async (dir: string) => {
    const path = join(dir, "apoio.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), path);
    return path;
  };
  const dir = await mkdtemp(join(tmpdir(), "assembly-routes-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  const support = await clipB(dir);
  await appendFile(support, Buffer.from("x"));
  let indexes = 0;
  const app = await startApp({
    projectDir: dir,
    inputs: [speech, support],
    port: 0,
    executor: {
      async run(call) {
        const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
        if (work && call.args.includes("index")) {
          indexes += 1;
          if (indexes > 1) throw new Error("falha no segundo arquivo");
          await mkdir(join(work, "out"), { recursive: true });
          await writeFile(join(work, "out", "speech_index.json"), `${JSON.stringify(INDEX)}\n`);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;
  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { assembly: { sources: { id: string }[] } };
  };
  const res = await fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceIds: opened.project.assembly.sources.map((s) => s.id) }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as {
    project: { analyses: { sourceId: string; status: string; speech: unknown[] }[] };
  };
  expect(body.project.analyses.length).toBe(2);
  expect(body.project.analyses[0]!.speech.length).toBeGreaterThan(0);
  expect(body.project.analyses[1]!.status).toBe("error");
});

it("duas prévias da mesma revisão usam pastas de trabalho distintas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-routes-"));
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const workDirs: string[] = [];
  const app = await startApp({
    projectDir: dir,
    inputs: [clip],
    port: 0,
    executor: {
      async run(call) {
        const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
        workDirs.push(work);
        await writeFile(join(work, "reference.mp4"), work);
        await new Promise((r) => setTimeout(r, 40));
        return { code: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  stop = app.close;
  const opened = await loadProject(dir);
  await saveProject(dir, opened.revision, (current) => ({
    ...current,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: [], support: [], gaps: [],
    }],
    structureApprovedRevision: current.revision,
  }));
  const loaded = await loadProject(dir);
  const url = `http://127.0.0.1:${app.port}`;
  const [a, b] = await Promise.all([
    fetch(`${url}/project/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: loaded.revision }),
    }),
    fetch(`${url}/project/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: loaded.revision }),
    }),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(new Set(workDirs).size).toBeGreaterThan(1);
});
