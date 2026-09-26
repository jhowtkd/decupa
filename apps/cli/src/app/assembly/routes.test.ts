import { runInNewContext } from "node:vm";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, unlink, writeFile, appendFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import type { Executor } from "../pipeline.ts";
import { startApp } from "../server.ts";
import { mediaWork } from "./media-work.ts";
import { applyCanvasPolicy } from "./canvas.ts";
import { paidBlockedReason, PAID_BLOCKED, blankProject, publishCorrection, createAssemblyRuntime } from "./routes.ts";
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
      const output = call.args.at(-1);
      if (call.command === "ffmpeg" && output?.includes("%03d")) {
        await writeFile(output.replace("%03d", "000"), "frame");
      }
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
    templatesRoot?: string;
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

it("seleção preserva alterações feitas enquanto o seletor está aberto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-select-"));
  const app = await startApp({
    projectDir: dir,
    port: 0,
    selectFn: async () => {
      await saveProject(dir, 0, (current) => ({
        ...current,
        revision: current.revision + 1,
        assembly: { ...current.assembly, revision: current.revision + 1 },
        input: { ...current.input, text: "briefing atualizado" },
      }));
      return { paths: [join(FIXTURES, "clip.mp4")] };
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;
  await selectClip(base);
  const project = await loadProject(dir);
  expect(project.revision).toBe(2);
  expect(project.input.text).toBe("briefing atualizado");
  expect(project.assembly.sources.map((source) => source.id)).toEqual(["src-1"]);
  await selectClip(base, 0);
  expect((await loadProject(dir)).assembly.sources).toHaveLength(1);
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
  expect(contexto).toContain("download");
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
  const finished = await (await fetch(`${base}/project`)).json() as { operation: { stage: string; error: string } };
  expect(finished.operation).toMatchObject({ stage: "error", error: "sem fala transcrita nas fontes incluídas" });
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

it("prévia cancelada na fila não lança render pela rota", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-routes-"));
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const calls: { command: string; args: string[] }[] = [];
  const app = await startApp({
    projectDir: dir,
    inputs: [clip],
    port: 0,
    executor: {
      async run(call) {
        calls.push({ command: call.command, args: call.args });
        const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
        if (work && call.command === "python3") {
          await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;
  const opened = await loadProject(dir);
  let release!: () => void;
  const holderGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = mediaWork.run(() => holderGate);
  try {
    const previewed = fetch(`${base}/project/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: opened.revision }),
    });
    await vi.waitFor(() => {
      expect(mediaWork.waiting).toBeGreaterThanOrEqual(1);
    }, { timeout: 10_000 });
    const cancelled = await fetch(`${base}/project/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    release();
    const res = await previewed;
    expect(res.status).not.toBe(200);
    expect(((await res.json()) as { error?: string }).error ?? "").toMatch(/cancelad|aborted/i);
    expect(calls.filter((c) => c.command === "python3")).toHaveLength(0);
    expect(calls.filter((c) => c.command === "ffmpeg" && (c.args.at(-1) ?? "").includes("hw-"))).toHaveLength(0);
    const state = await (await fetch(`${base}/project`)).json() as { operation: { stage: string } };
    expect(state.operation.stage).toBe("cancelled");
  } finally {
    release();
    await holding.catch(() => undefined);
  }
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
  }, { timeout: 10_000 });
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
          spans: [{ start: 0, end: 3, text: "pessoa falando", confidence: "observed", tags: [] }],
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
  // Consulta até ver a preparação em voo (prazo generoso para runner lento) e
  // mais algumas vezes depois: nenhuma consulta pode tratá-la como reinício.
  let sawRunning = false;
  let pollsAfterRunning = 0;
  const deadline = Date.now() + 15_000;
  while (pollsAfterRunning < 10 && Date.now() < deadline) {
    const poll = (await (await fetch(`${base}/project`)).json()) as {
      project: { preparation: { status: string; error?: string } | null };
    };
    if (poll.project.preparation) {
      expect(poll.project.preparation.error ?? "").not.toContain("servidor reiniciado");
      if (poll.project.preparation.status === "running") sawRunning = true;
    }
    if (sawRunning) pollsAfterRunning += 1;
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
  const afterAudio = applyCanvasPolicy(p);
  expect(afterAudio.assembly.width).toBe(320);
  const afterVideo = applyCanvasPolicy({
    ...afterAudio,
    assembly: { ...afterAudio.assembly, sources: [audio, video] },
  });
  expect(afterVideo.assembly.width).toBe(1920);
  expect(afterVideo.assembly.height).toBe(1080);
  expect(afterVideo.assembly.fps).toEqual({ num: 30000, den: 1001 });
  expect(afterVideo.assembly.canvasSourceId).toBe("cam");
  const second = { ...video, id: "cam2", width: 640, height: 360, fps: { num: 25, den: 1 } };
  const afterSecond = applyCanvasPolicy({
    ...afterVideo,
    assembly: { ...afterVideo.assembly, sources: [audio, video, second] },
  });
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

it("GET deriva Desfazer de histórico persistido e diagnostica corrupção", async()=>{
  const {dir,base,app}=await boot();
  expect((await (await fetch(`${base}/project`)).json() as {undoRevision:number|null}).undoRevision).toBeNull();
  const p=await loadProject(dir);
  const {writeHistorySnapshot}=await import("./store.ts");
  await writeHistorySnapshot(dir,p);
  await saveProject(dir,p.revision,{...p,revision:1,assembly:{...p.assembly,revision:1}});
  await app.close();
  const reopened=await startApp({projectDir:dir,port:0});stop=reopened.close;
  const url=`http://127.0.0.1:${reopened.port}/project`;
  expect((await (await fetch(url)).json() as {undoRevision:number|null}).undoRevision).toBe(0);
  await writeFile(join(dir,"history","rev-0.json"),"{quebrado");
  const corrupt=await fetch(url);
  expect(corrupt.ok).toBe(false);
});

it("edita apoio por HTTP, protege revisão e restaura por undo",async()=>{
  const {base,dir}=await boot();
  const p=await loadProject(dir);p.assembly=fixtureAssembly();
  p.analyses=[{sourceId:"a",key:"k",status:"ready",words:[],wordsStatus:"missing",visualCoverage:{requested:[],returned:[],missing:[]},speech:[{id:"a:s",sourceId:"a",start:0,end:3,text:"tema"}],visual:[{id:"b:v",sourceId:"b",start:0,end:2,text:"público",confidence:"observed",tags:[]}]}];
  const {validateProposal,compileScenes}=await import("./scenes.ts");
  p.scenes=validateProposal({id:"p",baseRevision:0,changedSceneIds:["s"],scenes:[{id:"s",speechIds:["a:s"]}]},p).scenes;
  p.assembly=compileScenes(p,p.scenes);await saveProject(dir,0,()=>p);
  const before=await (await fetch(`${base}/project`)).json() as {brollCandidates:{entries:unknown[]}[];project:Project};
  expect(before.brollCandidates[0]!.entries).toEqual([{visualId:"b:v",offsetFrames:0,durationFrames:50}]);
  expect(JSON.stringify(before.brollCandidates)).not.toContain("path");
  const post=(path:string,body:unknown)=>fetch(`${base}/project/${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const body={baseRevision:0,action:{type:"set-support",sceneId:"s",support:[{visualId:"b:v",offsetFrames:25,durationFrames:25}]}};
  expect((await post("edit",body)).status).toBe(200);
  expect((await post("edit",body)).status).toBe(409);
  const undo=await post("undo",{baseRevision:1,revision:0});expect(undo.status).toBe(200);
  const restored=await loadProject(dir);expect(restored.scenes[0]!.support).toEqual([]);expect(restored.revision).toBe(2);expect(restored.finalApprovedRevision).toBeNull();
});


it("novo projeto abre vazio e preserva projeto e mídia anteriores", async () => {
  const {base, dir} = await boot();
  await fetch(`${base}/project/input`, {method: "POST", headers: {"content-type":"application/json"},
    body: JSON.stringify({baseRevision:0,kind:"brief",text:"Projeto anterior",targetSeconds:60})});
  const before = await readFile(join(dir, "project.json"), "utf8");
  const res = await fetch(`${base}/project/new`, {method:"POST"});
  expect(res.status).toBe(201);
  const {url} = await res.json() as {url:string};
  const next = await (await fetch(new URL("project", url))).json() as {project:Project};
  expect(next.project.revision).toBe(0);
  expect(next.project.assembly.sources).toEqual([]);
  expect(next.project.scenes).toEqual([]);
  expect(next.project.input.text).toBe("");
  expect(await readFile(join(dir,"project.json"),"utf8")).toBe(before);
  const html = await (await fetch(url)).text();
  expect(html).toContain('id="newProject"');
});

it("template gera candidata sem mudar montagem; aceite muda revisão e recusa stale",async()=>{
 const {saveRecipe}=await import("../templates/store.ts");
 const templatesRoot=await mkdtemp(join(tmpdir(),"template-library-"));
 const recipe:import("../templates/types.ts").Recipe={id:"11111111-1111-4111-8111-111111111111",revision:1,name:"Evento",status:"draft",source:{path:"/tmp/reference.mp4",sha256:"a".repeat(64),durationSeconds:2},analysis:{status:"ready",stage:"complete"},rules:[]};
 await saveRecipe(templatesRoot,recipe,null);await saveRecipe(templatesRoot,{...recipe,status:"approved"},1);
 const {base,dir}=await boot([],{templatesRoot,allowPaidModel:true,proposeSend:async()=>JSON.stringify({changedSceneIds:["s1"],scenes:[{id:"s1",objective:"abertura",rationale:"fala",selections:[{speechId:"u"}],support:[],gaps:[]}],templateReport:[],explanation:"receita"})});
 const p=await loadProject(dir);p.assembly=fixtureAssembly();p.assembly.revision=p.revision;p.analyses=[{sourceId:"a",key:"k",status:"ready",speech:[{id:"u",sourceId:"a",start:0,end:1,text:"tema"}],visual:[],words:[],wordsStatus:"missing",visualCoverage:{requested:[],returned:[],missing:[]}}];
 p.assembly.sources=p.assembly.sources.filter(s=>s.id==="a");p.assembly.tracks.forEach(t=>t.clips=[]);
 await saveProject(dir,p.revision,()=>p);
 const r=await fetch(base+"/project/template-proposal",{method:"POST",body:JSON.stringify({baseRevision:p.revision,templateId:recipe.id,templateRevision:1,modelOptIn:true})});
 expect(r.status).toBe(200);const data=await r.json() as any;
 expect((await loadProject(dir)).scenes).toHaveLength(0);
 const accepted=await fetch(base+"/project/template-accept",{method:"POST",body:JSON.stringify({baseRevision:p.revision,proposalId:data.templateProposal.id})});
 expect(accepted.status).toBe(200);expect((await loadProject(dir)).template?.id).toBe(recipe.id);
 expect((await fetch(base+"/project/template-accept",{method:"POST",body:JSON.stringify({baseRevision:p.revision,proposalId:data.templateProposal.id})})).status).toBe(409);
});

it("relatório do template acompanha aceite/rejeição/desfazer (#68)",async()=>{
 const {saveRecipe}=await import("../templates/store.ts");
 const templatesRoot=await mkdtemp(join(tmpdir(),"template-library-"));
 const rule=(id:string,enabled=true)=>({id,category:"narrative" as const,observation:"obs",instruction:`inst ${id}`,enabled,confidence:"observed" as const,evidence:[{start:0,end:1}]});
 const recipe:import("../templates/types.ts").Recipe={id:"22222222-2222-4222-8222-222222222222",revision:1,name:"Evento",status:"draft",source:{path:"/tmp/reference.mp4",sha256:"a".repeat(64),durationSeconds:2},analysis:{status:"ready",stage:"complete"},rules:[rule("r1"),rule("r2"),rule("r3",false)]};
 await saveRecipe(templatesRoot,recipe,null);await saveRecipe(templatesRoot,{...recipe,status:"approved"},1);
 const proposeBody=()=>JSON.stringify({changedSceneIds:["s1"],scenes:[{id:"s1",objective:"abertura",rationale:"fala",animationNotes:[{id:"n1",description:"lower third",destination:"Resolve"}],selections:[{speechId:"u"}],support:[],gaps:[]}],templateReport:[{ruleId:"r1",status:"applied",reason:"regra seguida",sceneIds:["s1"]},{ruleId:"r2",status:"unavailable",reason:"material sem variação"}],explanation:"receita"});
 const {base,dir}=await boot([],{templatesRoot,allowPaidModel:true,proposeSend:async()=>proposeBody()});
 const p=await loadProject(dir);p.assembly=fixtureAssembly();p.assembly.revision=p.revision;p.analyses=[{sourceId:"a",key:"k",status:"ready",speech:[{id:"u",sourceId:"a",start:0,end:1,text:"tema"}],visual:[],words:[],wordsStatus:"missing",visualCoverage:{requested:[],returned:[],missing:[]}}];
 p.assembly.sources=p.assembly.sources.filter(s=>s.id==="a");p.assembly.tracks.forEach(t=>t.clips=[]);
 await saveProject(dir,p.revision,()=>p);
 type Report={recipe:{id:string;revision:number}|null;rules:{ruleId:string;status:string;sceneIds:string[]|null}[];animations:{id:string;sceneId:string;durationFrames:number}[]};
 const getReport=async()=>((await (await fetch(base+"/project")).json()) as {templateReport:Report}).templateReport;
 // Projeto sem template: relatório vazio e explícito.
 expect(await getReport()).toEqual({recipe:null,rules:[],animations:[]});
 // Proposta rejeitada não deixa relatório nem receita.
 const first=await fetch(base+"/project/template-proposal",{method:"POST",body:JSON.stringify({baseRevision:p.revision,templateId:recipe.id,templateRevision:1,modelOptIn:true})});
 expect(first.status).toBe(200);const d1=await first.json() as any;
 const cur=await loadProject(dir);
 expect((await fetch(base+"/project/template-reject",{method:"POST",body:JSON.stringify({baseRevision:cur.revision,proposalId:d1.templateProposal.id})})).status).toBe(200);
 expect(await getReport()).toEqual({recipe:null,rules:[],animations:[]});
 expect((await loadProject(dir)).template).toBeFalsy();
 // Nova proposta aceita: relatório congela receita+revisão, cobre regras
 // ativas (não a desabilitada), cenas navegáveis e animação como handoff.
 const cur2=await loadProject(dir);
 const second=await fetch(base+"/project/template-proposal",{method:"POST",body:JSON.stringify({baseRevision:cur2.revision,templateId:recipe.id,templateRevision:1,modelOptIn:true})});
 const d2=await second.json() as any;
 const accepted=await fetch(base+"/project/template-accept",{method:"POST",body:JSON.stringify({baseRevision:cur2.revision,proposalId:d2.templateProposal.id})});
 expect(accepted.status).toBe(200);
 const report=await getReport();
 expect(report.recipe).toEqual({id:recipe.id,revision:1,name:"Evento"});
 expect(report.rules.map(r=>r.ruleId)).toEqual(["r1","r2"]);
 expect(report.rules[0]).toMatchObject({status:"applied",reason:"regra seguida",sceneIds:["s1"]});
 expect(report.rules[1]).toMatchObject({status:"unavailable",sceneIds:null});
 expect(report.animations).toEqual([{id:"n1",description:"lower third",destination:"Resolve",sceneId:"s1",startFrame:0,durationFrames:25}]);
 // Desfazer restaura projeto sem template e sem relatório.
 const cur3=await loadProject(dir);
 const undo=await fetch(base+"/project/undo",{method:"POST",body:JSON.stringify({baseRevision:cur3.revision,revision:cur3.revision-1})});
 expect(undo.status).toBe(200);
 expect(await getReport()).toEqual({recipe:null,rules:[],animations:[]});
});
