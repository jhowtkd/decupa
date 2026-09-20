import { runInNewContext } from "node:vm";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, unlink, writeFile, appendFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { paidBlockedReason, PAID_BLOCKED, applyCanvasFrom, blankProject, publishCorrection, createAssemblyRuntime } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { applyHistorySnapshot } from "./revisions.ts";
import type { Project, Source } from "./types.ts";
import { createProject, loadProject, readHistorySnapshot, saveProject } from "./store.ts";

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
    speech?: import("../pipeline.ts").IngestSpeech;
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
  const rail = await (await fetch(`${base}/editor/rail.js`)).text();
  const contexto = await (await fetch(`${base}/editor/contexto.js`)).text();
  expect(html).toContain("decupa · montagem");
  expect(html).not.toContain("decupa · limpar fala");
  // Bancada: topbar + 4 mounts (rail/texto/contexto/faixa) preservados.
  expect(html).toContain('id="topbar"');
  expect(html).toContain('id="status"');
  expect(html).toContain('id="rail"');
  expect(html).toContain('id="texto"');
  expect(html).toContain('id="contexto"');
  expect(html).toContain('id="faixa"');
  expect(css).toContain(".riscado");
  expect(js).toContain("/editor/rail.js");
  expect(js).toContain("scheduleAutoPreview");
  expect(contexto).toContain("previewPlayer");
  expect(contexto).toContain("/project/output/");
  expect(contexto).toContain("Preparar montagem");
  expect(rail).toContain("Retomar");
  expect(rail).toContain("download");
  expect(html).not.toContain("approve-structure");
});

it("serve módulos editor sem build", async () => {
  const { base } = await boot();
  const res = await fetch(`${base}/editor/state.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/javascript");
  const bad = await fetch(`${base}/editor/..%2F..%2Fwords.ts`);
  expect([403, 404]).toContain(bad.status);
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

it("POST /analyze no serviço residente usa o worker e não spawnam transcribe.py", async () => {
  const workerCalls: string[] = [];
  const { base, clip } = await boot([], {
    executor: indexingExec(),
    speech: {
      worker: async (req) => {
        workerCalls.push(req.taskId);
        return {
          language: req.language,
          words: [{ text: "oi", startMs: 0, endMs: 40, confidence: 1, sentenceIndex: 0 }],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
    },
  });
  await fetch(`${base}/project/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0 }),
  });
  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { assembly: { sources: { id: string; path: string }[] } };
  };
  const res = await fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceIds: opened.project.assembly.sources.map((s) => s.id),
      visual: false,
    }),
  });
  expect(res.status).toBe(200);
  const stored = opened.project.assembly.sources[0]?.path;
  expect(stored).toBeTruthy();
  // sourceFromFile canonicaliza com realpath: no macOS /var vs /private/var,
  // no Windows 8.3 (RUNNER~1) vs o caminho longo. O taskId do worker é esse
  // path gravado, não a grafia do mkdtemp que o boot() devolve.
  expect(workerCalls).toEqual([stored]);
  expect(stored).toBe(await realpath(clip));
});

it("POST /project/cancel cancela só o worker da fonte em análise", async () => {
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { resume = resolve; });
  const cancelled: string[] = [];
  const { base } = await boot([], {
    executor: indexingExec(),
    speech: {
      worker: async (req) => {
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            cancelled.push(req.taskId);
            reject(new Error(`tarefa cancelada: ${req.taskId}`));
          };
          if (req.signal?.aborted) {
            fail();
            return;
          }
          req.signal?.addEventListener("abort", fail, { once: true });
          resume();
        });
        return {
          language: "pt",
          words: [],
          unaligned: [],
        };
      },
      extract: async () => {},
      detectSilence: async () => [],
    },
  });
  await fetch(`${base}/project/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0 }),
  });
  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { assembly: { sources: { id: string; path: string }[] } };
  };
  const stored = opened.project.assembly.sources[0]?.path;
  const analyze = fetch(`${base}/project/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceIds: opened.project.assembly.sources.map((s) => s.id),
      visual: false,
    }),
  });
  await started;
  const cancel = await fetch(`${base}/project/cancel`, { method: "POST" });
  expect(cancel.status).toBe(200);
  expect((await cancel.json() as { operation: { stage: string } }).operation.stage).toBe("cancelled");
  await analyze;
  expect(cancelled).toEqual([stored]);
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
  const { base, clip } = await boot([], {
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

it("publishCorrection faz rebase e publica quando a revisão avançou por edição concorrente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-corr-rebase-"));
  const p = blankProject("p1");
  p.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1" });
  p.analyses.push({
    sourceId: "src1", key: "k", speech: [], visual: [], status: "ready", words: [
      { id: "src1:h:w0", sourceId: "src1", start: 0, end: 1, text: "errada", confidence: 0.9 },
    ], wordsStatus: "ready", visualCoverage: { requested: [], returned: [], missing: [] },
  });
  p.corrections.push({
    id: "corr-1", sourceId: "src1", start: 0, end: 1, text: "certa", status: "pending", words: [],
  });
  await createProject(dir, p);

  // Simula que uma edição de usuário passou na frente e avançou a revisão para 1
  await saveProject(dir, 0, (curr) => ({ ...curr, revision: 1 }));

  // publishCorrection chamado com base revision 0 original
  await publishCorrection(dir, 0, "corr-1", {
    words: [{ text: "certa", start: 0, end: 1, confidence: 0.95 }],
  });

  const final = await loadProject(dir);
  const corr = final.corrections.find((c) => c.id === "corr-1");
  expect(corr?.status).toBe("aligned");
  expect(corr?.words[0]?.text).toBe("certa");
});

it("GET /project não trata prepare em voo como reinício do servidor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-inflight-prep-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  let release!: (value: string) => void;
  const blocked = new Promise<string>((resolve) => {
    release = resolve;
  });
  const app = await startApp({
    projectDir: dir,
    inputs: [speech],
    port: 0,
    executor: indexingExec(),
    proposeSend: () => blocked,
    describeClient: {
      async send() {
        return JSON.stringify({
          spans: [{ start: 0, end: 1, text: "pessoa falando", confidence: "observed", tags: [] }],
        });
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;
  const opened = await (await fetch(`${base}/project`)).json() as { project: { revision: number } };
  const started = await fetch(`${base}/project/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: opened.project.revision,
      request: "montar tudo",
      modelOptIn: true,
      visualOptIn: true,
    }),
  });
  expect(started.status).toBe(202);
  let sawRunning = false;
  for (let i = 0; i < 25; i += 1) {
    const poll = (await (await fetch(`${base}/project`)).json()) as {
      project: { preparation: { status: string; error?: string } | null };
    };
    if (poll.project.preparation) {
      expect(poll.project.preparation.error ?? "").not.toContain("servidor reiniciado");
      if (poll.project.preparation.status === "running") sawRunning = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  expect(sawRunning).toBe(true);
  release(JSON.stringify({
    scenes: [{ id: "sc-1", objective: "Abertura", selections: [{ speechId: "x" }] }],
    changedSceneIds: ["sc-1"],
    explanation: "ok",
  }));
});

it("GET /project reconcilia status running órfão para interrupted após reinício do servidor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-orphan-run-"));
  const p = blankProject("p1");
  p.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1" });
  p.preparation = {
    id: "prep-stale", revision: 0, mode: "prepare", request: "teste",
    status: "running", stage: "media", sources: {},
  };
  await createProject(dir, p);

  const app = await startApp({ projectDir: dir, port: 0 });
  stop = app.close;
  const res = await fetch(`http://127.0.0.1:${app.port}/project`);
  const body = await res.json() as { project: { preparation?: { status?: string; error?: string } } };
  expect(body.project.preparation?.status).toBe("interrupted");
  expect(body.project.preparation?.error).toContain("servidor reiniciado");
});

it("publishCorrection assenta error quando o save não é conflito de revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-corr-err-"));
  const p = blankProject("p1");
  p.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1" });
  p.corrections.push({
    id: "corr-1", sourceId: "src1", start: 0, end: 1, text: "certa", status: "pending", words: [],
  });
  await createProject(dir, p);
  await publishCorrection(dir, 0, "corr-1", {
    words: [{ text: "certa", start: 0, end: 1, confidence: 0.95, cutStart: -1, cutEnd: 1 }],
  });
  const final = await loadProject(dir);
  const corr = final.corrections.find((c) => c.id === "corr-1");
  expect(corr?.status).toBe("error");
  expect(corr?.error?.length).toBeGreaterThan(0);
});

it("GET /project relança pending órfão e assenta error se a fonte falhar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-corr-resume-"));
  const p = blankProject("p1");
  p.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1" });
  p.corrections.push({
    id: "corr-stale", sourceId: "src1", start: 0, end: 1, text: "certa", status: "pending", words: [],
  });
  await createProject(dir, p);
  const app = await startApp({ projectDir: dir, port: 0 });
  stop = app.close;
  await fetch(`http://127.0.0.1:${app.port}/project`);
  let settled: { status?: string } | undefined;
  for (let i = 0; i < 50 && !settled; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const body = await (await fetch(`http://127.0.0.1:${app.port}/project`)).json() as {
      project: { corrections: { id: string; status: string }[] };
    };
    const corr = body.project.corrections.find((c) => c.id === "corr-stale");
    if (corr && corr.status !== "pending") settled = corr;
  }
  expect(settled?.status).toBe("error");
});

it("canvas vem do primeiro vídeo mesmo com áudio já cadastrado", () => {
  const audio: Source = {
    ...fixtureAssembly().sources[0]!,
    id: "wav",
    hasVideo: false,
    hasAudio: true,
    width: null,
    height: null,
    fps: null,
    role: "speech",
  };
  const video: Source = {
    ...fixtureAssembly().sources[0]!,
    id: "cam",
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    fps: { num: 30000, den: 1001 },
    role: "speech",
  };
  let p = blankProject("p1");
  expect(p.assembly.width).toBe(320);
  p = {
    ...p,
    assembly: { ...p.assembly, sources: [audio] },
  };
  const afterAudio = applyCanvasFrom(p, audio);
  expect(afterAudio.assembly.width).toBe(320);
  const afterVideo = applyCanvasFrom(afterAudio, video);
  expect(afterVideo.assembly.width).toBe(1920);
  expect(afterVideo.assembly.height).toBe(1080);
  expect(afterVideo.assembly.fps).toEqual({ num: 30000, den: 1001 });
  const second = { ...video, id: "cam2", width: 640, height: 360, fps: { num: 25, den: 1 } };
  const afterSecond = applyCanvasFrom({
    ...afterVideo,
    assembly: { ...afterVideo.assembly, sources: [audio, video] },
  }, second);
  expect(afterSecond.assembly.width).toBe(1920);
  expect(afterSecond.assembly.fps).toEqual({ num: 30000, den: 1001 });
});

// --- ICE3-01: snapshot de histórico no /apply (chamada direta, sem listen) ---

type RespostaDireta = { status: number; corpo: Record<string, unknown> };

async function chamadaDireta(
  dir: string,
  caminho: string,
  corpo: unknown,
): Promise<RespostaDireta> {
  const runtime = createAssemblyRuntime(dir, {
    exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    port: () => 0,
  });
  const carga = Buffer.from(JSON.stringify(corpo));
  const req = {
    method: "POST",
    url: caminho,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield carga;
    },
  };
  let status = 0;
  let texto = "";
  const res = {
    writeHead(codigo: number) { status = codigo; },
    end(parte?: unknown) { if (typeof parte === "string") texto = parte; },
  };
  await runtime.handleAssembly(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    dir,
  );
  return { status, corpo: JSON.parse(texto) as Record<string, unknown> };
}

function projetoComCorte(): { projeto: Project; cenaOriginal: Project["scenes"][number] } {
  const projeto = blankProject("p1");
  projeto.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1", durationSeconds: 10 });
  projeto.analyses.push({
    sourceId: "src1",
    key: "k",
    speech: [
      { id: "src1:u001", sourceId: "src1", start: 0, end: 2, text: "fala um" },
      { id: "src1:u002", sourceId: "src1", start: 2, end: 4, text: "fala dois" },
    ],
    visual: [],
    status: "ready",
    words: [
      { id: "w1", sourceId: "src1", start: 0, end: 1, text: "fala", confidence: 0.9 },
      { id: "w2", sourceId: "src1", start: 1, end: 2, text: "um", confidence: 0.9 },
    ],
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  });
  const cenaOriginal: Project["scenes"][number] = {
    id: "s1",
    objective: "abrir",
    rationale: "tema",
    speechIds: ["src1:u001"],
    takes: [{
      id: "t1", sourceId: "src1", speechId: "src1:u001",
      start: 0, end: 2, removed: [{ start: 0, end: 0.5 }], protected: [],
    }],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  };
  projeto.scenes.push(cenaOriginal);
  return { projeto, cenaOriginal };
}

it("apply fotografa o histórico: undo restaura takes/cortes anteriores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-apply-snap-"));
  const { projeto, cenaOriginal } = projetoComCorte();
  projeto.proposal = {
    id: "prop-1",
    baseRevision: 0,
    changedSceneIds: ["s1"],
    explanation: "troca a fala da cena",
    scenes: [{
      id: "s1", objective: "abrir de novo", rationale: "tema",
      selections: [{ speechId: "src1:u002" }], support: [], gaps: [],
    }],
  } as unknown as Project["proposal"];
  await createProject(dir, projeto);

  const resposta = await chamadaDireta(dir, "/project/apply", { baseRevision: 0, proposalId: "prop-1" });
  expect(resposta.status).toBe(200);

  const atual = await loadProject(dir);
  expect(atual.revision).toBe(1);
  expect(atual.scenes[0]!.takes.map((take) => take.id)).toEqual(["s1:src1:u002"]);

  const snap = await readHistorySnapshot(dir, 0);
  expect(snap.scenes).toEqual([cenaOriginal]);

  const desfeito = applyHistorySnapshot(atual, snap);
  expect(desfeito.scenes).toEqual([cenaOriginal]);
  expect(desfeito.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0, end: 0.5 }]);
});

it("apply com proposta ausente retorna 409 sem quebrar o fluxo de undo seguinte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-apply-409-"));
  const { projeto, cenaOriginal } = projetoComCorte();
  await createProject(dir, projeto);

  const falha = await chamadaDireta(dir, "/project/apply", { baseRevision: 0, proposalId: "prop-fantasma" });
  expect(falha.status).toBe(409);

  const intacto = await loadProject(dir);
  expect(intacto.revision).toBe(0);
  expect(intacto.scenes).toEqual([cenaOriginal]);

  const editado = await chamadaDireta(dir, "/project/edit", {
    baseRevision: 0,
    action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"] },
  });
  expect(editado.status).toBe(200);

  const desfeito = await chamadaDireta(dir, "/project/undo", { baseRevision: 1, revision: 0 });
  expect(desfeito.status).toBe(200);
  const final = await loadProject(dir);
  expect(final.revision).toBe(2);
  expect(final.scenes).toEqual([cenaOriginal]);
});


it("importação sem conexão informa recuperação, interrompe o lote e libera o seletor", async () => {
  const js = await readFile(new URL("./page.js", import.meta.url), "utf8");
  const source = js.slice(js.indexOf("async function importFiles("), js.indexOf("/* ---- Fiação ---- */"));
  const drop = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
  const ui = { label: null, error: null };
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  const importFiles = runInNewContext(source + "; importFiles", {
    document: { getElementById: () => drop }, ui, fetch, TypeError,
    project: () => ({ revision: 0 }), renderStatus: vi.fn(),
  });
  await expect(importFiles([{ name: "primeiro.MOV", size: 10 }, { name: "segundo.MOV", size: 10 }])).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(ui.error).toContain("Sem conexão com o Decupa");
  expect(ui.error).toContain("mesmo projeto");
  expect(ui.label).toBeNull();
  expect((ui as typeof ui & { importing: boolean }).importing).toBe(false);
  expect(drop.removeAttribute).toHaveBeenCalledWith("aria-disabled");
});


it("bloqueia mutações durante importação e sincroniza revisão após conflito sem repetir escrita", async () => {
  const js = await readFile(new URL("./page.js", import.meta.url), "utf8");
  const source = js.slice(js.indexOf("async function call("), js.indexOf("const api ="));
  const ui = { importing: true, error: null };
  const client = { call: vi.fn() };
  const state = { set: vi.fn() };
  const call = runInNewContext(source + "; call", { ui, client, state, renderStatus: vi.fn(), maybeScheduleAutoPreview: vi.fn() });
  const opts = { method: "POST", body: JSON.stringify({ baseRevision: 1 }) };
  expect((await call("/project/source-role", opts)).res.ok).toBe(false);
  expect(client.call).not.toHaveBeenCalled();
  expect(ui.error).toContain("Aguarde o envio");
  ui.importing = false;
  client.call.mockResolvedValueOnce({ res: { ok: false, status: 409 }, body: { error: "revisão desatualizada" } });
  client.call.mockResolvedValueOnce({ res: { ok: true }, body: { project: { revision: 3 } } });
  await call("/project/source-role", opts);
  expect(client.call).toHaveBeenCalledTimes(2);
  expect(client.call).toHaveBeenLastCalledWith("/project");
  expect(state.set).toHaveBeenCalledWith("project", { revision: 3 });
});
