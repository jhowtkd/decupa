import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCoordinator } from "@decupa/coordinator";
import { expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { startApp } from "./server.ts";

const analysisMetricsClose = vi.hoisted(() => ({
  active: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  finished: undefined as (() => void) | undefined,
}));

vi.mock("@decupa/bench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@decupa/bench")>();
  return {
    ...actual,
    createOperationMetrics(opts: Parameters<typeof actual.createOperationMetrics>[0]) {
      const metrics = actual.createOperationMetrics(opts);
      if (opts.metadata?.operation !== "analyze-sources") return metrics;
      return {
        ...metrics,
        async close() {
          if (analysisMetricsClose.active) {
            analysisMetricsClose.entered?.();
            await analysisMetricsClose.release;
          }
          await metrics.close();
          if (analysisMetricsClose.active) analysisMetricsClose.finished?.();
        },
      };
    },
  };
});

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

async function seedMedia(root: string, nome = "gravacao.mp4", fixture = "clip.mp4"): Promise<{
  mediaRoot: string;
  mediaId: string;
  bytes: Buffer;
}> {
  const mediaRoot = join(root, "media");
  const bytes = await readFile(join(FIXTURES, fixture));
  const mediaId = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(mediaRoot, "pool"), { recursive: true });
  await writeFile(join(mediaRoot, "pool", mediaId), bytes);
  await writeFile(join(mediaRoot, "pool", `${mediaId}.json`), JSON.stringify({
    id: mediaId, nome, tamanho: bytes.byteLength, duracao: 1, criadoEm: Date.now(),
  }));
  return { mediaRoot, mediaId, bytes };
}

async function diagDump(label: string, projectsRoot: string, base: string, url: string): Promise<void> {
  const say = (line: string) => console.error(`[diag:${label}] ${line}`);
  say(`tmpdir=${tmpdir()} (${tmpdir().length}) node=${process.version} platform=${process.platform}`);
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name);
      say(`fs ${entry.isDirectory() ? "d" : "f"} nameBytes=${Buffer.byteLength(entry.name)} pathChars=${full.length} ${full.slice(projectsRoot.length)}`);
      if (entry.isDirectory()) await walk(full);
      else if (/\.jsonl$|analysis\.json$|project\.json$|waiters\.json$|\/tasks\/|\/slots\//.test(full)) {
        say(`content ${(await readFile(full, "utf8").catch((error: unknown) => `erro ${String(error)}`)).slice(0, 1500)}`);
      }
    }
  };
  await walk(projectsRoot);
  if (base && url) {
    const state = await fetch(`${base}${url}project`).then((response) => response.text()).catch((error: unknown) => `erro ${String(error)}`);
    say(`GET project ${state.slice(0, 1500)}`);
  }
}

it("cria uma Montagem nomeada na Raiz e devolve sua URL no mesmo servidor", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-http-"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Reunião da Equipe", fluxo: "montagem" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; url: string };
    expect(body.id).toMatch(/^reuniao-da-equipe-[a-z0-9]{4}$/);
    expect(body.url).toBe(`/projects/${body.id}/`);
    await access(join(root, body.id, "project.json"));
    expect(JSON.parse(await readFile(join(root, body.id, "project.json"), "utf8")))
      .toMatchObject({ assembly: { name: "Reunião da Equipe" } });
    expect((await fetch(`http://127.0.0.1:${app.port}${body.url}`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("limita o nome da pasta em bytes e conserva nomes longos completos na exibição", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-long-name-http-"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  const names = [
    "a".repeat(251),
    `${"á".repeat(30)}${"a".repeat(230)}`,
  ];
  try {
    for (const nome of names) {
      const response = await fetch(`http://127.0.0.1:${app.port}/project/new`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nome, fluxo: "montagem" }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { id: string };
      expect(Buffer.byteLength(body.id, "utf8")).toBeLessThanOrEqual(245);
      expect(JSON.parse(await readFile(join(root, body.id, "project.json"), "utf8")))
        .toMatchObject({ assembly: { name: nome } });
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejeita nome vazio, fluxo inválido e Limpeza sem Mídia sem criar pasta", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-invalid-http-"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  try {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${app.port}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    for (const body of [
      { nome: "  ", fluxo: "montagem" },
      { nome: "Teste", fluxo: "desconhecido" },
      { nome: "Teste", fluxo: "limpeza" },
      { nome: "Teste", fluxo: "limpeza", midias: ["a", "b"] },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(await readdir(root)).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("usa o nome do Projeto no manifesto e serve Range na Limpeza criada do acervo", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-cleanup-media-http-"));
  const projectsRoot = join(root, "projects");
  const { mediaRoot, mediaId, bytes } = await seedMedia(root);
  const app = await startApp({ projectsRoot, port: 0, executor, autoStart: false, env: { DECUPA_MEDIA_ROOT: mediaRoot } });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Aula de Física", fluxo: "limpeza", midias: [mediaId] }),
    });

    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; url: string };
    expect(created.url).toBe(`/projects/${created.id}/`);
    const source = JSON.parse(await readFile(join(projectsRoot, created.id, "source.json"), "utf8")) as { path: string; displayName: string };
    expect(source).toMatchObject({ displayName: "Aula de Física" });
    expect(await realpath(source.path)).toBe(await realpath(join(mediaRoot, "pool", mediaId)));
    await expect(access(join(projectsRoot, created.id, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const page = await fetch(`${base}${created.url}`);
    expect(page.status).toBe(200);
    const jobId = (await page.text()).match(/\|\| ("[^"]+")/)?.[1]?.replaceAll('"', "");
    expect(jobId).toBeTruthy();
    expect(await (await fetch(`${base}${created.url}jobs/${jobId}`)).json()).toMatchObject({ source: "Aula de Física" });

    const range = await fetch(`${base}${created.url}media`, { headers: { range: "bytes=2-7" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 2-7/${bytes.byteLength}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(2, 8));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("aplica a política de canvas ao criar Montagem já com Mídia", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-assembly-canvas-http-"));
  const projectsRoot = join(root, "projects");
  const { mediaRoot, mediaId } = await seedMedia(root, "vertical.mp4", "vertical-360x640.mov");
  const app = await startApp({ projectsRoot, port: 0, executor, autoStart: false, env: { DECUPA_MEDIA_ROOT: mediaRoot } });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const create = (body: object) => fetch(`${base}/project/new`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const createdWithMedia = await (await create({ nome: "Com mídia", fluxo: "montagem", midias: [mediaId] })).json() as { url: string };
    const createdEmpty = await (await create({ nome: "Vazia", fluxo: "montagem" })).json() as { url: string };
    const withMedia = await (await fetch(`${base}${createdWithMedia.url}project`)).json() as { project: { assembly: Record<string, unknown> } };
    const empty = await (await fetch(`${base}${createdEmpty.url}project`)).json() as { project: { revision: number; assembly: Record<string, unknown> } };
    const added = await fetch(`${base}${createdEmpty.url}project/media`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: empty.project.revision, mediaId }),
    });
    expect(added.status).toBe(202);
    const throughRoute = await added.json() as { project: { assembly: Record<string, unknown> } };
    expect(withMedia.project.assembly.fps).toEqual(throughRoute.project.assembly.fps);
    expect(withMedia.project.assembly.width).toBe(throughRoute.project.assembly.width);
    expect(withMedia.project.assembly.height).toBe(throughRoute.project.assembly.height);
    expect(withMedia.project.assembly.canvasSourceId).toMatch(/^src-/);
    expect(throughRoute.project.assembly.canvasSourceId).toMatch(/^src-/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("aguarda a análise de Mídia e o journal antes de fechar e apagar a Montagem", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-analysis-close-http-"));
  const projectsRoot = join(root, "projects");
  const { mediaRoot, mediaId } = await seedMedia(root, "fala.wav", "tone-gap.wav");
  const diagStart = Date.now();
  const diag = (step: string) => console.error(`[diag +${Date.now() - diagStart}ms] ${step}`);
  let diagBase = "";
  let diagUrl = "";
  const watchdog = setInterval(() => { void diagDump("watchdog", projectsRoot, diagBase, diagUrl); }, 8_000);
  diag(`mediaId=${mediaId}`);
  let signalEntered!: () => void;
  let releaseAnalysis!: () => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  let signalMetricsClose!: () => void;
  let signalMetricsFinished!: () => void;
  let releaseMetricsClose!: () => void;
  const metricsCloseEntered = new Promise<void>((resolve) => { signalMetricsClose = resolve; });
  const metricsCloseFinished = new Promise<void>((resolve) => { signalMetricsFinished = resolve; });
  const metricsCloseBlocked = new Promise<void>((resolve) => { releaseMetricsClose = resolve; });
  analysisMetricsClose.active = true;
  analysisMetricsClose.entered = signalMetricsClose;
  analysisMetricsClose.release = metricsCloseBlocked;
  analysisMetricsClose.finished = signalMetricsFinished;
  const app = await startApp({
    projectsRoot,
    port: 0,
    executor,
    autoStart: false,
    env: { DECUPA_MEDIA_ROOT: mediaRoot },
    speech: {
      worker: async () => {
        diag("worker: entrou");
        signalEntered();
        await blocked;
        diag("worker: liberado");
        return { language: "pt", words: [], unaligned: [] };
      },
      extract: async (o: { input: string; output: string }) => { diag(`extract: chamado input=${o.input}`); },
      detectSilence: async () => { diag("detectSilence: chamado"); return []; },
    },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    diagBase = base;
    const created = await (await fetch(`${base}/project/new`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Análise em andamento", fluxo: "montagem" }),
    })).json() as { id: string; url: string };
    diagUrl = created.url;
    diag(`projeto criado ${created.id}`);
    const empty = await (await fetch(`${base}${created.url}project`)).json() as { project: { revision: number } };
    const added = await fetch(`${base}${created.url}project/media`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: empty.project.revision, mediaId }),
    });
    expect(added.status).toBe(202);
    diag("POST project/media 202; aguardando entered");
    await entered;
    diag("entered ok");

    let closeFinished = false;
    const closing = app.close().then(() => { closeFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closeFinishedWhileBlocked = closeFinished;

    releaseAnalysis();
    diag("análise liberada; aguardando metricsCloseEntered");
    await metricsCloseEntered;
    diag("metricsCloseEntered ok");
    let closeFinishedWhileJournalBlocked = false;
    void closing.then(() => { closeFinishedWhileJournalBlocked = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const journalStillBlocking = !closeFinishedWhileJournalBlocked;
    releaseMetricsClose();
    diag("journal liberado; aguardando metricsCloseFinished");
    await metricsCloseFinished;
    diag("metricsCloseFinished ok; aguardando closing");
    await closing;
    diag("closing ok");
    // Só dê tempo para a gravação antiga terminar se as capturas já provaram
    // que close resolveu antes do worker ou do journal. No caminho correto,
    // a remoção acontece imediatamente após confirmar o flush abaixo.
    if (closeFinishedWhileBlocked || !journalStillBlocking) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const metricsDir = join(projectsRoot, created.id, ".decupa", "metrics");
    const journals = await readdir(metricsDir);
    const analysisJournal = journals.find((name) => name.endsWith(".jsonl"));
    expect(analysisJournal).toBeTruthy();
    expect(await readFile(join(metricsDir, analysisJournal!), "utf8")).toContain('"kind":"operation-finished"');
    await rm(join(projectsRoot, created.id), { recursive: true, force: true });
    expect(await readdir(projectsRoot)).toEqual([]);
    expect(closeFinishedWhileBlocked).toBe(false);
    expect(journalStillBlocking).toBe(true);
  } finally {
    clearInterval(watchdog);
    await diagDump("finally", projectsRoot, "", "").catch(() => undefined);
    releaseAnalysis();
    releaseMetricsClose();
    analysisMetricsClose.active = false;
    analysisMetricsClose.entered = undefined;
    analysisMetricsClose.release = undefined;
    analysisMetricsClose.finished = undefined;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejeita Mídia inexistente ao criar Limpeza sem criar Projeto", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-cleanup-missing-media-http-"));
  const projectsRoot = join(root, "projects");
  const mediaRoot = join(root, "media");
  const app = await startApp({ projectsRoot, port: 0, executor, autoStart: false, env: { DECUPA_MEDIA_ROOT: mediaRoot } });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Limpeza", fluxo: "limpeza", midias: ["a".repeat(64)] }),
    });
    expect(response.status).toBe(404);
    expect(await readdir(projectsRoot)).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("aceita Mídias do acervo na criação de Montagem e serve a fonte dentro do Projeto", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-assembly-media-http-"));
  const projectsRoot = join(root, "projects");
  const { mediaRoot, mediaId, bytes } = await seedMedia(root);
  const app = await startApp({ projectsRoot, port: 0, executor, autoStart: false, env: { DECUPA_MEDIA_ROOT: mediaRoot } });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Montagem da aula", fluxo: "montagem", midias: [mediaId] }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; url: string };
    const project = JSON.parse(await readFile(join(projectsRoot, created.id, "project.json"), "utf8")) as {
      assembly: { sources: { id: string; path: string; sha256: string; name: string }[] };
    };
    expect(project.assembly.sources).toHaveLength(1);
    expect(project.assembly.sources[0]).toMatchObject({ sha256: mediaId, name: "gravacao.mp4" });

    // A mesma Mídia pedida duas vezes (o hash em qualquer caixa) vira uma fonte só.
    const twice = await (await fetch(`${base}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Duas vezes", fluxo: "montagem", midias: [mediaId, mediaId.toUpperCase()] }),
    })).json() as { id: string };
    const twiceProject = JSON.parse(await readFile(join(projectsRoot, twice.id, "project.json"), "utf8")) as {
      assembly: { sources: unknown[] };
    };
    expect(twiceProject.assembly.sources).toHaveLength(1);

    const range = await fetch(`${base}${created.url}project/media/${encodeURIComponent(project.assembly.sources[0]!.id)}`, {
      headers: { range: "bytes=3-9" },
    });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(3, 10));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("ao abrir a Limpeza criada na Raiz, coloca o preparo na fila global", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-new-cleanup-queue-http-"));
  const projectsRoot = join(root, "projects");
  const coordinatorDir = join(root, "queue");
  const engine = join(root, "engine");
  await mkdir(join(engine, "mcp", "ve_tools"), { recursive: true });
  await writeFile(join(engine, "mcp", "ve_tools", "condense.py"), "# fake\n");
  await writeFile(join(engine, "mcp", "ve_tools", "condense_lang.py"), "_TERMINAL_PUNCT = \".。！？!?…\"\nFILLERS_SOFT_PT = []\n");
  const { mediaRoot, mediaId } = await seedMedia(root);
  let entered = 0;
  let release!: () => void;
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = createFileCoordinator(coordinatorDir, { limit: 1 });
  const held = holder.withSlot({ stage: "transcribing" }, () => {
    acquired();
    // O slot só libera quando o Projeto já demonstrou que ficou aguardando.
    return new Promise<void>((resolve) => { release = resolve; });
  });
  await acquiredPromise;
  const previousEngine = process.env.VE_PLUGIN_ROOT;
  process.env.VE_PLUGIN_ROOT = engine;
  const executor = {
    async run(call: { args: string[]; env?: Record<string, string> }) {
      if (call.args.includes("index")) {
        await mkdir(join(call.env?.CLAUDE_PROJECT_DIR ?? root, "out"), { recursive: true });
        await writeFile(join(call.env?.CLAUDE_PROJECT_DIR ?? root, "out", "speech_index.json"), JSON.stringify({ units: [] }));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const speech = {
    worker: async (_req: { language: string }) => {
      entered += 1;
      return { language: "pt", words: [{ text: "oi", startMs: 0, endMs: 80, confidence: 1, sentenceIndex: 0 }], unaligned: [] };
    },
    extract: async () => undefined,
    detectSilence: async () => [],
  };
  const app = await startApp({
    projectsRoot, port: 0, executor, speech, coordinatorDir,
    env: { DECUPA_MEDIA_ROOT: mediaRoot },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const created = await (await fetch(`${base}/project/new`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Limpeza enfileirada", fluxo: "limpeza", midias: [mediaId] }),
    })).json() as { id: string; url: string };
    const page = await fetch(`${base}${created.url}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const jobId = html.match(/\|\| ("[^"]+")/)?.[1];
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(entered).toBe(0);
    release();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const check = () => {
        if (entered > 0) resolve();
        else if (Date.now() >= deadline) reject(new Error(`preparo não entrou na fila global (${jobId ?? "sem job"})`));
        else setTimeout(check, 10);
      };
      check();
    });
    const jobPath = `${base}${created.url}jobs/${jobId?.replaceAll('"', "")}`;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await (await fetch(jobPath)).json() as { stage: string };
      if (!["queued", "transcribing", "indexing", "visual"].includes(state.stage)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    release();
    await app.close();
    await held.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (previousEngine === undefined) delete process.env.VE_PLUGIN_ROOT;
    else process.env.VE_PLUGIN_ROOT = previousEngine;
    await rm(root, { recursive: true, force: true });
  }
});

it("renomeia só a exibição e mantém a pasta e a URL do Projeto", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-rename-http-"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const created = await (await fetch(`${base}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Nome original", fluxo: "montagem" }),
    })).json() as { id: string; url: string };
    const renamed = await fetch(`${base}${created.url}project/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Nome exibido" }),
    });

    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { project: { assembly: { name: string } } }).project.assembly.name)
      .toBe("Nome exibido");
    expect((await fetch(`${base}${created.url}`)).status).toBe(200);
    await expect(access(join(root, created.id))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(root, created.id, "project.json"), "utf8")))
      .toMatchObject({ assembly: { name: "Nome exibido" } });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
