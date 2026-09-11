import { copyFile, mkdir, mkdtemp, readdir, readFile, unlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { paidBlockedReason, PAID_BLOCKED, blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
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
      if (work) await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
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
  const css = await (await fetch(`${base}/page.css`)).text();
  const js = await (await fetch(`${base}/page.js`)).text();
  expect(html).toContain("decupa · montagem");
  expect(html).not.toContain("decupa · limpar fala");
  expect(html).toContain("<video");
  expect(html).toContain("previewPlayer");
  expect(html).toContain("Preparar montagem");
  expect(html).toContain("review-grid");
  expect(css).toContain(".review-grid");
  expect(js).toContain("/project/output/");
  expect(js).toContain("download");
  expect(html).toContain("Retomar");
  expect(js).toContain("Subir");
  expect(html).not.toContain("approve-structure");
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

it("gate pago do percurso: bloqueia sem autorização, libera com opt-in ou permissão", () => {
  const withVideo = {
    ...blankProject("gate"),
    assembly: { ...blankProject("gate").assembly, sources: [fixtureAssembly().sources[0]!] },
  };
  const transports = { proposeSend: "x", describeClient: "x" };
  expect(
    paidBlockedReason(withVideo, {}, { modelOptIn: false, visualOptIn: false, needsModel: true }),
  ).toBe(PAID_BLOCKED);
  expect(
    paidBlockedReason(withVideo, transports, { modelOptIn: true, visualOptIn: false, needsModel: true }),
  ).toBe(PAID_BLOCKED);
  expect(
    paidBlockedReason(withVideo, transports, { modelOptIn: true, visualOptIn: true, needsModel: true }),
  ).toBeNull();
  expect(
    paidBlockedReason(
      withVideo,
      { allowPaidModel: true, allowPaidVisual: true, ...transports },
      { modelOptIn: false, visualOptIn: false, needsModel: true },
    ),
  ).toBeNull();
  const permitted = {
    ...withVideo,
    permissions: { model: true, visual: true },
  };
  expect(
    paidBlockedReason(permitted, transports, { modelOptIn: false, visualOptIn: false, needsModel: true }),
  ).toBeNull();
  const audioOnly = {
    ...blankProject("gate-audio"),
    assembly: { ...blankProject("gate-audio").assembly, sources: [] },
  };
  expect(
    paidBlockedReason(audioOnly, { proposeSend: "x" }, { modelOptIn: true, visualOptIn: false, needsModel: true }),
  ).toBeNull();
});

it("prepare sem autorização devolve 402 sem chamar o provedor", async () => {
  let called = 0;
  const { base } = await boot([], {
    executor: indexingExec(),
    proposeSend: async () => {
      called += 1;
      return "{}";
    },
    describeClient: {
      async send() {
        called += 1;
        return JSON.stringify({ spans: [] });
      },
    },
  });
  const res = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, request: "montar tudo" }),
  });
  expect(res.status).toBe(402);
  expect(called).toBe(0);
});

it("prepare com opt-in devolve 202 e interrompe sem fala em projeto vazio", async () => {
  const { base } = await boot([], {
    executor: indexingExec(),
    proposeSend: async () => "{}",
    describeClient: {
      async send() {
        return JSON.stringify({ spans: [] });
      },
    },
  });
  const started = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, request: "montar tudo", modelOptIn: true, visualOptIn: true }),
  });
  expect(started.status).toBe(202);
  let status: string | null = null;
  for (let i = 0; i < 50 && !status; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = (await (await fetch(`${base}/project`)).json()) as {
      project: { preparation: { status: string } | null };
    };
    if (poll.project.preparation && poll.project.preparation.status !== "running") {
      status = poll.project.preparation.status;
    }
  }
  expect(status).toBe("interrupted");
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
        // Mídia válida: o probe recusa bytes arbitrários com 500.
        await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
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
      id: "s1", objective: "abrir", rationale: "tema", speechIds: [], takes: [],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
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

type ProjectSummary = {
  project: {
    revision: number;
    assembly: { sources: { id: string; name: string; path: string; included: boolean; role: string }[] };
  };
};

async function selectClip(base: string, baseRevision = 0): Promise<ProjectSummary> {
  const res = await fetch(`${base}/project/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ProjectSummary;
}

async function importBytes(
  base: string,
  name: string,
  baseRevision: number,
  bytes: Uint8Array,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/project/import?name=${encodeURIComponent(name)}&baseRevision=${baseRevision}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-size": String(bytes.length),
      ...extraHeaders,
    },
    body: bytes,
  });
}

it("busca trecho do proxy por Range e serve miniatura", async () => {
  const { base } = await boot();
  const selected = await selectClip(base);
  const id = selected.project.assembly.sources[0]!.id;
  const full = await fetch(`${base}/project/media/${id}?view=playback`);
  expect(full.status).toBe(200);
  const part = await fetch(`${base}/project/media/${id}?view=playback`, {
    headers: { range: "bytes=0-99" },
  });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toMatch(/^bytes 0-99\//);
  const thumb = await fetch(`${base}/project/thumbnail/${id}`);
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get("content-type")).toBe("image/jpeg");
});

it("falha de proxy não publica parcial e nomeia a fonte", async () => {
  const { base } = await boot([], {
    executor: {
      async run() { return { code: 1, stdout: "", stderr: "boom" }; },
    },
  });
  const selected = await selectClip(base);
  const id = selected.project.assembly.sources[0]!.id;
  const res = await fetch(`${base}/project/media/${id}?view=playback`);
  expect(res.status).toBe(409);
  expect(await res.text()).toContain(id);
});

it("mídia ausente e substituída viram erro com ID, sem render", async () => {
  const calls: { args: string[] }[] = [];
  const { base, dir, clip } = await boot([], {
    executor: { async run(call: { args: string[] }) { calls.push(call); return { code: 0, stdout: "", stderr: "" }; } },
  });
  const selected = await selectClip(base);
  const id = selected.project.assembly.sources[0]!.id;
  await unlink(clip);
  expect((await fetch(`${base}/project/media/${id}`)).status).toBe(404);
  expect((await fetch(`${base}/project/media/${id}?view=playback`)).status).toBe(404);
  await copyFile(join(FIXTURES, "edited.wav"), clip);
  const sub = await fetch(`${base}/project/media/${id}?view=playback`);
  expect(sub.status).toBe(409);
  expect(await sub.text()).toContain(id);
  expect(calls).toHaveLength(0);
});

it("importa por stream, reutiliza por hash e recusa entrada inválida", async () => {
  const { base } = await boot();
  const bytes = await readFile(join(FIXTURES, "clip.mp4"));
  const first = await importBytes(base, "fala.mp4", 0, bytes);
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as ProjectSummary & { source: { id: string; name: string } };
  expect(firstBody.source.name).toBe("fala.mp4");
  const stored = firstBody.project.assembly.sources[0]!;
  expect(stored.path).toContain("imports");
  expect(stored.path).not.toContain("fala.mp4");
  expect(firstBody.project.revision).toBe(1);
  const second = await importBytes(base, "outro-nome.mp4", 1, bytes);
  const secondBody = (await second.json()) as { reused: boolean; source: { id: string } };
  expect(second.status).toBe(200);
  expect(secondBody.reused).toBe(true);
  expect(secondBody.source.id).toBe(firstBody.source.id);
  expect((await importBytes(base, "../x.mp4", 1, bytes)).status).toBe(400);
  const noSize = await fetch(`${base}/project/import?name=a.mp4&baseRevision=1`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect(noSize.status).toBe(400);
  const txt = Buffer.from("não é mídia");
  expect((await importBytes(base, "nota.txt", 1, txt)).status).toBe(400);
});

it("upload abortado não registra fonte nem deixa .part", async () => {
  const { base, dir } = await boot();
  const bytes = await readFile(join(FIXTURES, "clip.mp4"));
  const controller = new AbortController();
  const req = fetch(`${base}/project/import?name=grande.mp4&baseRevision=0`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-size": String(bytes.length * 10),
    },
    body: bytes,
    signal: controller.signal,
  });
  controller.abort();
  await expect(req).rejects.toThrow();
  await vi.waitFor(async () => {
    const files = await readdir(join(dir, "imports")).catch(() => [] as string[]);
    expect(files.filter((file) => file.endsWith(".part"))).toEqual([]);
  });
  const body = (await (await fetch(`${base}/project`)).json()) as ProjectSummary;
  expect(body.project.revision).toBe(0);
  expect(body.project.assembly.sources).toEqual([]);
});

it("lote e categorias: selection e role em lote e singular", async () => {
  const { base } = await boot();
  const clip = await readFile(join(FIXTURES, "clip.mp4"));
  const wav = await readFile(join(FIXTURES, "edited.wav"));
  const one = (await (await importBytes(base, "um.mp4", 0, clip)).json()) as { source: { id: string } };
  const two = (await (await importBytes(base, "dois.wav", 1, wav)).json()) as { source: { id: string } };
  const roleBatch = await fetch(`${base}/project/source-role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 2, sourceIds: [one.source.id, two.source.id], role: "support" }),
  });
  expect(roleBatch.status).toBe(200);
  const roles = ((await roleBatch.json()) as ProjectSummary).project.assembly.sources;
  expect(roles.map((source) => source.role)).toEqual(["support", "support"]);
  const roleOne = await fetch(`${base}/project/source-role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 3, sourceId: one.source.id, role: "speech" }),
  });
  expect(roleOne.status).toBe(200);
  const single = await fetch(`${base}/project/source-selection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 4, sourceIds: [two.source.id], included: false }),
  });
  expect(single.status).toBe(200);
  const sources = ((await single.json()) as ProjectSummary).project.assembly.sources;
  expect(sources.find((source) => source.id === two.source.id)!.included).toBe(false);
  expect(sources.find((source) => source.id === one.source.id)!.included).toBe(true);
  const unknown = await fetch(`${base}/project/source-selection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 5, sourceIds: ["fantasma"], included: false }),
  });
  expect(unknown.status).toBe(404);
});
