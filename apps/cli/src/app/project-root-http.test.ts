import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";
import { sourceManifestPath } from "./session.ts";
import type { ExecCall } from "./pipeline.ts";

const metricsAppendGate = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
  spansGate: undefined as Promise<void> | undefined,
  spansStarted: undefined as (() => void) | undefined,
  spansWritten: undefined as (() => void) | undefined,
  postCloseJournalFinished: undefined as (() => void) | undefined,
  closeCompleted: false,
  metricsCreatedAfterClose: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      const path = String(args[0]);
      if (path.includes("/.decupa/metrics/") && metricsAppendGate.closeCompleted
        && String(args[1]).includes('"kind":"operation-finished"')) {
        metricsAppendGate.postCloseJournalFinished?.();
      }
      if (path.includes("/.decupa/metrics/") && metricsAppendGate.gate) {
        metricsAppendGate.started?.();
        await metricsAppendGate.gate;
      }
      return actual.appendFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).endsWith("/fillers-spans-1.json") && metricsAppendGate.spansGate) {
        metricsAppendGate.spansStarted?.();
        await metricsAppendGate.spansGate;
        const result = await actual.writeFile(...args);
        metricsAppendGate.spansWritten?.();
        return result;
      }
      return actual.writeFile(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]).endsWith("/.decupa/metrics") && metricsAppendGate.closeCompleted) {
        metricsAppendGate.metricsCreatedAfterClose = true;
      }
      return actual.mkdir(...args);
    },
  };
});

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

function rawStatus(base: string, path: string): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

it("serve duas Montagens da mesma Raiz sob ids distintos", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-http-"));
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await mkdir(alpha);
  await mkdir(beta);
  await createProject(alpha, blankProject("alpha-project"));
  await createProject(beta, blankProject("beta-project"));

  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const alphaPage = await fetch(`${base}/projects/alpha/`);
    const betaPage = await fetch(`${base}/projects/beta/`);

    expect(alphaPage.status).toBe(200);
    expect(betaPage.status).toBe(200);
    expect(await alphaPage.text()).toContain('content="/projects/alpha"');
    expect(await betaPage.text()).toContain('content="/projects/beta"');
    const [alphaProject, betaProject] = await Promise.all([
      fetch(`${base}/projects/alpha/project`),
      fetch(`${base}/projects/beta/project`),
    ]);
    expect(alphaProject.status).toBe(200);
    expect(betaProject.status).toBe(200);
    expect((await alphaProject.json() as { project: { id: string } }).project.id).toBe("alpha-project");
    expect((await betaProject.json() as { project: { id: string } }).project.id).toBe("beta-project");
    expect((await fetch(`${base}/templates`)).status).toBe(200);
    for (const asset of ["page.css", "page.js", "project-path.js", "edit-reservation-ui.js", "editor/rail.js"]) {
      const response = await fetch(`${base}/projects/alpha/${asset}`);
      expect(response.status, asset).toBe(200);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("recusa ids inválidos ou que não são Projetos sem sair da Raiz", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-security-"));
  await mkdir(join(root, "arquivo"));
  const valid = join(root, "valido");
  await mkdir(valid);
  await createProject(valid, blankProject("valid-project"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    for (const id of ["ausente", "%2e%2e", "a%2fb", "a%2Fb", "%2e%2e%2fvalido", "%2Fetc", "%5Cetc", "%00", ".", ".."] ) {
      // fetch normaliza `%2e%2e` para `/`; a requisição HTTP crua conserva o
      // caminho que o roteador precisa recusar.
      expect(await rawStatus(base, `/projects/${id}/`), id).toBe(404);
    }
    expect((await fetch(`${base}/projects/arquivo/`)).status).toBe(404);
    expect((await fetch(`${base}/projects/valido//`)).status).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("serve Projetos da Raiz com nomes codificados e mantém traversal fora da Raiz", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-nomes-http-"));
  const nomes = ["Meu Vídeo", "lição", "aula(1)", "a+b", "100%"];
  for (const nome of nomes) {
    const dir = join(root, nome);
    await mkdir(dir);
    await createProject(dir, blankProject(nome));
  }
  const limpezas = nomes.map((nome) => `.decupa-${nome}.mp4`);
  for (const id of limpezas) {
    const input = join(root, `${id.slice(".decupa-".length)}`);
    const dir = join(root, id);
    await writeFile(input, "media fake", "utf8");
    const source = await stat(input);
    await mkdir(dir);
    await writeFile(sourceManifestPath(dir), JSON.stringify({ path: input, size: source.size, mtimeMs: source.mtimeMs }));
  }
  const initial = join(root, "Meu Vídeo");
  const app = await startApp({ projectsRoot: root, projectId: "Meu Vídeo", projectDir: initial, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(base, { redirect: "manual" })).headers.get("location")).toBe("/projects/Meu%20V%C3%ADdeo/");
    for (const nome of nomes) {
      const encoded = encodeURIComponent(nome);
      const page = await fetch(`${base}/projects/${encoded}/`);
      expect(page.status, nome).toBe(200);
      expect(await page.text(), nome).toContain(`content="/projects/${encoded}"`);
      expect((await fetch(`${base}/projects/${encoded}/project`)).status).toBe(200);
    }
    for (const id of limpezas) {
      const encoded = encodeURIComponent(id);
      expect((await fetch(`${base}/projects/${encoded}/`)).status, id).toBe(200);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("oculta somente o sufixo stale gerado, não um nome que contém .stale-", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-stale-http-"));
  const named = join(root, ".decupa-aula.stale-backup.mp4");
  const stale = join(root, ".decupa-aula.mp4.stale-2026-10-15T12-00-00-000Z");
  await mkdir(named); await mkdir(stale);
  await createProject(named, blankProject("named-stale"));
  await createProject(stale, blankProject("generated-stale"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/projects/${encodeURIComponent(".decupa-aula.stale-backup.mp4")}/`)).status).toBe(200);
    expect((await fetch(`${base}/projects/${encodeURIComponent(".decupa-aula.mp4.stale-2026-10-15T12-00-00-000Z")}/`)).status).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("deriva o Projeto inicial de projectDir e redireciona a raiz do site", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-initial-"));
  const projectDir = join(root, "inicial");
  const app = await startApp({ projectsRoot: root, projectDir, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(base, { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/projects/inicial/");
    expect((await fetch(`${base}/projects/inicial/`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("serve o hub da Raiz quando não há Projeto inicial", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-index-http-"));
  const assembly = join(root, "Meu Projeto");
  await mkdir(assembly);
  await createProject(assembly, blankProject("assembly-project", "Montagem da equipe"));
  const input = join(root, "aula.mp4");
  const cleanup = join(root, ".decupa-aula.mp4");
  await writeFile(input, "media fake", "utf8");
  const source = await stat(input);
  await mkdir(cleanup);
  await writeFile(sourceManifestPath(cleanup), JSON.stringify({
    path: input, size: source.size, mtimeMs: source.mtimeMs, displayName: "Aula da equipe",
  }), "utf8");

  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toContain("Projetos recentes");
    expect(html).toContain("Novo Projeto");
    expect(html).toContain("/hub/page.css");
    expect(html).toContain("/hub/page.js");
    expect((await fetch(`${base}/hub/page.css`)).status).toBe(200);
    expect((await fetch(`${base}/hub/page.js`)).status).toBe(200);
    expect(html).not.toContain("Forçar Liberação");
    expect(html).not.toContain("lock");
    const projects = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; nome: string; fluxo: string }>;
    expect(projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Meu Projeto", nome: "Montagem da equipe", fluxo: "montagem" }),
      expect.objectContaining({ id: ".decupa-aula.mp4", nome: "Aula da equipe", fluxo: "limpeza" }),
    ]));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("aguarda o journal de métricas antes de concluir app.close", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-metrics-close-"));
  const cleanup = join(root, ".decupa-aula.mp4");
  await mkdir(cleanup);
  // A fonte ausente faz o preflight terminar sem iniciar trabalho de mídia.
  await writeFile(sourceManifestPath(cleanup), JSON.stringify({ path: join(root, "ausente.mp4") }), "utf8");

  let notifyAppendStarted!: () => void;
  const appendStarted = new Promise<void>((resolve) => { notifyAppendStarted = resolve; });
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  metricsAppendGate.gate = appendGate;
  metricsAppendGate.started = notifyAppendStarted;

  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/projects/${encodeURIComponent(".decupa-aula.mp4")}/`);
    expect(response.status).toBe(200);
    await appendStarted;

    let closeFinished = false;
    const close = app.close().then(() => { closeFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeFinished).toBe(false);

    releaseAppend();
    await close;
    const metricsDir = join(cleanup, ".decupa", "metrics");
    const journals = await readdir(metricsDir);
    const records = (await Promise.all(journals.filter((name) => name.endsWith(".jsonl")).map(async (name) =>
      (await readFile(join(metricsDir, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string }),
    ))).flat();
    const kinds = records.map((record) => record.kind);
    expect(kinds).toContain("ingest-result");
    expect(kinds).toContain("operation-finished");
    await rm(root, { recursive: true, force: true });
    expect(await fsPromises.access(root).then(() => true, () => false)).toBe(false);
  } finally {
    releaseAppend();
    metricsAppendGate.gate = undefined;
    metricsAppendGate.started = undefined;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("não inicia uv sync depois do cancelamento durante o preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-preflight-close-"));
  const cleanup = join(root, ".decupa-legivel.mp4");
  const input = join(root, "legivel.mp4");
  await writeFile(input, "fonte legível", "utf8");
  await mkdir(cleanup);
  await writeFile(sourceManifestPath(cleanup), JSON.stringify({ path: input }), "utf8");

  let notifyUvVersionStarted!: () => void;
  const uvVersionStarted = new Promise<void>((resolve) => { notifyUvVersionStarted = resolve; });
  let releaseUvVersion!: () => void;
  const uvVersionGate = new Promise<void>((resolve) => { releaseUvVersion = resolve; });
  let closeRequested = false;
  let syncStartedAfterClose = false;
  const injectedExecutor = {
    async run(call: ExecCall) {
      if (call.command === "uv" && call.args[0] === "--version") {
        notifyUvVersionStarted();
        await uvVersionGate;
      }
      if (call.command === "uv" && call.args[0] === "sync" && closeRequested) {
        syncStartedAfterClose = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  const app = await startApp({ projectsRoot: root, port: 0, executor: injectedExecutor, env: {} });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/projects/${encodeURIComponent(".decupa-legivel.mp4")}/`);
    expect(response.status).toBe(200);
    await uvVersionStarted;

    closeRequested = true;
    const close = app.close();
    releaseUvVersion();
    await close;

    expect(syncStartedAfterClose).toBe(false);
    await rm(root, { recursive: true, force: true });
    expect(await fsPromises.access(root).then(() => true, () => false)).toBe(false);
  } finally {
    releaseUvVersion();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("não cria journal depois do close se o replanejamento estava gravando spans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-root-replan-close-"));
  const video = join(dir, "video.mp4");
  const engine = join(dir, "engine");
  await writeFile(video, "fake video", "utf8");
  const source = await stat(video);
  await writeFile(sourceManifestPath(dir), JSON.stringify({ path: video, size: source.size, mtimeMs: source.mtimeMs }), "utf8");
  await mkdir(join(dir, "out"));
  await mkdir(join(engine, "mcp", "ve_tools"), { recursive: true });
  await writeFile(join(engine, "mcp", "ve_tools", "condense.py"), 'args.get("drop_filler_spans")', "utf8");
  const words = [{ text: "Bom", start: 0, end: 0.3 }, { text: "hã", start: 0.35, end: 0.55 }, { text: "dia", start: 0.6, end: 1 }];
  const units = [{ id: "u001", index: 0, start: 0, end: 1.5, duration: 1.5, text: "Bom hã dia", words }];
  const transcript = JSON.stringify({ segments: units.map((unit) => ({ start: unit.start, end: unit.end, text: unit.text,
    words: unit.words.map((word, index) => ({ ...word, id: `${unit.id}:w${index}`, confidence: 1 })) })) });
  await writeFile(join(dir, "transcript.json"), transcript, "utf8");
  await writeFile(join(dir, "out", "speech_index.json"), JSON.stringify({ units, transcript_sha256: createHash("sha256").update(transcript).digest("hex") }), "utf8");
  await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({ source_duration: 1.5, output_duration: 1.5,
    clips: [{ unit_ids: ["u001"], start: 0, end: 1.5 }], joins: [] }), "utf8");

  let notifyWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve; });
  let notifySpansWritten!: () => void;
  const spansWritten = new Promise<void>((resolve) => { notifySpansWritten = resolve; });
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let notifyPostCloseJournalFinished!: () => void;
  const postCloseJournalFinished = new Promise<void>((resolve) => { notifyPostCloseJournalFinished = resolve; });
  metricsAppendGate.spansGate = writeGate;
  metricsAppendGate.spansStarted = notifyWriteStarted;
  metricsAppendGate.spansWritten = notifySpansWritten;
  metricsAppendGate.postCloseJournalFinished = notifyPostCloseJournalFinished;
  metricsAppendGate.closeCompleted = false;
  metricsAppendGate.metricsCreatedAfterClose = false;

  const app = await startApp({ input: video, workDir: dir,
    executor: { run: async (call: ExecCall) => ({ code: call.signal?.aborted ? 1 : 0, stdout: "", stderr: "" }) },
    autoStart: false, port: 0, env: { VE_PLUGIN_ROOT: engine } });
  const request = fetch(`http://127.0.0.1:${app.port}/jobs/${app.jobId}/keep`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepList: "u001" }),
  }).catch(() => undefined);
  try {
    await writeStarted;
    await app.close();
    metricsAppendGate.closeCompleted = true;
    expect(await fsPromises.access(join(dir, ".decupa", "metrics")).then(() => true, () => false)).toBe(false);

    releaseWrite();
    await spansWritten;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(metricsAppendGate.metricsCreatedAfterClose).toBe(false);
  } finally {
    releaseWrite();
    if (metricsAppendGate.metricsCreatedAfterClose) await postCloseJournalFinished;
    metricsAppendGate.spansGate = undefined;
    metricsAppendGate.spansStarted = undefined;
    metricsAppendGate.spansWritten = undefined;
    metricsAppendGate.postCloseJournalFinished = undefined;
    await app.close();
    await request;
    metricsAppendGate.closeCompleted = false;
    metricsAppendGate.metricsCreatedAfterClose = false;
    await rm(dir, { recursive: true, force: true });
  }
});

it("mantém /healthz aberto e sem dados da Raiz mesmo com login ligado", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-health-http-"));
  const project = join(root, "segredo do Projeto");
  await mkdir(project);
  await createProject(project, blankProject("project-id", "Nome privado"));
  const app = await startApp({
    projectsRoot: root, providerConfigDir: root, port: 0, executor,
    env: { DECUPA_AUTH_PASSWORD: "senha privada", DECUPA_SESSION_SECRET: "segredo" },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(body).not.toContain("senha privada");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("cria Montagem nova pelo caminho usado pelo editor na mesma Raiz", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-new-"));
  const existing = join(root, "existente");
  await mkdir(existing);
  await createProject(existing, blankProject("existing-project"));
  const app = await startApp({ projectsRoot: root, projectId: "existente", port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${base}/projects/existente/project/new`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Outra Montagem", fluxo: "montagem" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; url: string };
    const id = body.url.match(/^\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/$/)?.[1];
    expect(id).toMatch(/^outra-montagem-[a-z0-9]{4}$/);
    expect(body.id).toBe(id);
    const dir = join(root, id!);
    await access(join(dir, "project.json"));
    expect(JSON.parse(await readFile(join(dir, "project.json"), "utf8")))
      .toMatchObject({ assembly: { name: "Outra Montagem" } });
    expect((await fetch(`${base}${body.url}`)).status).toBe(200);
    expect((await fetch(`${base}${body.url}project`)).status).toBe(200);

    const rootResponse = await fetch(`${base}/project/new`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Raiz", fluxo: "montagem" }),
    });
    expect(rootResponse.status).toBe(201);
    const rootBody = await rootResponse.json() as { id: string; url: string };
    expect(rootBody).toEqual({ id: rootBody.id, url: `/projects/${rootBody.id}/` });
    expect((await fetch(`${base}${rootBody.url}`)).status).toBe(200);
    expect((await fetch(`${base}${rootBody.url}project`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

// O modo Raiz é o que a CLI sobe: o login e o bind valem para ele como para
// os modos legados, senão a equipe acessaria os Projetos sem senha.
it("modo Raiz exige sessão com senha e recusa bind exposto sem senha", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-auth-"));
  await mkdir(join(root, "alpha"));
  await createProject(join(root, "alpha"), blankProject("alpha-project"));
  await expect(startApp({ projectsRoot: root, port: 0, executor, env: { DECUPA_BIND_HOST: "0.0.0.0" } }))
    .rejects.toThrow(/DECUPA_AUTH_PASSWORD/);

  const app = await startApp({ projectsRoot: root, port: 0, executor, providerConfigDir: root,
    env: { DECUPA_AUTH_PASSWORD: "senha", DECUPA_SESSION_SECRET: "segredo" } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/projects/alpha/project`)).status).toBe(401);
    const page = await fetch(`${base}/projects/alpha/`, { redirect: "manual", headers: { accept: "text/html" } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/projects/alpha/")}`);
    expect((await fetch(`${base}/project/new`, { method: "POST", headers: { origin: base } })).status).toBe(401);

    const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual",
      headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ senha: "senha", nome: "Ana" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/projects/alpha/project`, { headers: { cookie } })).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
