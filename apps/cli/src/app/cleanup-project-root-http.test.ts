import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { sourceManifestPath } from "./session.ts";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

function pageResources(html: string): string[] {
  const resources = new Set<string>();
  const attributes = /\b(?:src|href)=["']([^"']+)["']/g;
  for (const match of html.matchAll(attributes)) resources.add(match[1]!);
  const imports = /(?<![\w-])(?:import\b\s*(?:\(\s*)?|from\b\s+)(["'])([^"']+)\1/g;
  for (const match of html.matchAll(imports)) resources.add(match[2]!);
  const dynamicProjectImports = /\bimport\s*\(\s*projectPath\(\s*["']([^"']+)["']\s*\)\s*\)/g;
  for (const match of html.matchAll(dynamicProjectImports)) resources.add(match[1]!);
  return [...resources].filter((resource) => !resource.startsWith("data:") && !resource.startsWith("mailto:"));
}

async function expectPageResources(base: string, pageUrl: URL, html: string, id: string): Promise<void> {
  const pending: Array<{ url: URL; body: string }> = [{ url: pageUrl, body: html }];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const resource of pageResources(current.body)) {
      if (resource.startsWith("#")) continue;
      const resourceUrl = new URL(resource, current.url);
      if (resourceUrl.origin !== base) throw new Error(`${id}: recurso saiu da origem: ${resourceUrl}`);
      const key = resourceUrl.href;
      if (seen.has(key)) continue;
      seen.add(key);
      const response = await fetch(resourceUrl);
      expect(response.status, `${id}: ${resource}`).toBe(200);
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("javascript") || resourceUrl.pathname.endsWith(".js")) {
        pending.push({ url: resourceUrl, body: await response.text() });
      }
    }
  }
}

it("serve Montagem e Limpeza da mesma Raiz sob prefixos distintos", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-project-root-http-"));
  const assembly = join(root, "montagem");
  const cleanup = join(root, "limpeza");
  const input = join(root, "aula.mp4");
  await mkdir(assembly);
  await createProject(assembly, blankProject("assembly-project"));
  await mkdir(cleanup);
  await writeFile(input, "media fake", "utf8");
  const source = await stat(input);
  await writeFile(sourceManifestPath(cleanup), JSON.stringify({
    path: input, size: source.size, mtimeMs: source.mtimeMs,
  }), "utf8");

  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const [assemblyPage, cleanupPage] = await Promise.all([
      fetch(`${base}/projects/montagem/`),
      fetch(`${base}/projects/limpeza/`),
    ]);
    expect(assemblyPage.status).toBe(200);
    expect(cleanupPage.status).toBe(200);
    const cleanupHtml = await cleanupPage.text();
    expect(cleanupHtml).toContain('content="/projects/limpeza"');
    const jobId = /\|\|\s*"([0-9a-f-]{36})"/.exec(cleanupHtml)?.[1];
    expect(jobId).toBeDefined();
    const job = await (await fetch(`${base}/projects/limpeza/jobs/${jobId}`)).json() as { source?: string };
    expect(job.source).toBe("aula.mp4");
    await writeFile(join(cleanup, "out", "condense_plan.json"), "{}", "utf8");
    const exported = await fetch(`${base}/projects/limpeza/jobs/${jobId}/export`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "transcript" }),
    });
    expect(exported.status).toBe(200);
    expect((await exported.json() as { downloadUrl: string }).downloadUrl)
      .toBe(`/projects/limpeza/jobs/${jobId}/download/transcript`);
    await writeFile(join(cleanup, "out", "condensed_transcript.json"), "{}", "utf8");
    const download = await fetch(`${base}/projects/limpeza/jobs/${jobId}/download/transcript`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("{}");

    for (const asset of ["project-path.js", "keeplist.js", "fillers-ui.js", "review-generation.js"]) {
      const response = await fetch(`${base}/projects/limpeza/${asset}`);
      expect(response.status, asset).toBe(200);
    }
    const media = await fetch(`${base}/projects/limpeza/media`);
    expect(media.status).toBe(200);
    expect(await media.text()).toBe("media fake");

    const manifest = JSON.parse(await readFile(sourceManifestPath(cleanup), "utf8")) as {
      flow?: string;
      displayName?: string;
    };
    expect(manifest).toMatchObject({ flow: "limpeza", displayName: "aula.mp4" });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("limpeza local no modo Raiz cria e retoma o Projeto ao lado da Mídia", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-project-local-http-"));
  const input = join(root, "aula.mp4");
  const workDir = join(root, `.decupa-${basename(input)}`);
  await writeFile(input, "media fake", "utf8");
  const source = await stat(input);
  await mkdir(workDir);
  await writeFile(sourceManifestPath(workDir), JSON.stringify({
    path: input, size: source.size, mtimeMs: source.mtimeMs, flow: "cleanup", displayName: "Aula antiga",
  }), "utf8");
  const app = await startApp({
    input, projectsRoot: root, projectDir: workDir, projectId: basename(workDir),
    port: 0, autoStart: false, executor, env: {},
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(307);
    expect((await fetch(`${base}/projects/${basename(workDir)}/`)).status).toBe(200);
    expect((await fetch(`${base}/projects/${basename(workDir)}/media`)).status).toBe(200);
    const manifest = JSON.parse(await readFile(sourceManifestPath(workDir), "utf8")) as { flow?: string };
    expect(manifest.flow).toBe("limpeza");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("descarrega Limpeza ociosa e recarrega o Projeto com relógio injetado", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-project-idle-http-"));
  const project = join(root, "limpeza");
  const input = join(root, "aula.mp4");
  await writeFile(input, "media fake", "utf8");
  const source = await stat(input);
  await mkdir(project);
  await writeFile(sourceManifestPath(project), JSON.stringify({
    path: input, size: source.size, mtimeMs: source.mtimeMs,
  }), "utf8");
  let clock = 0;
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor,
    now: () => clock, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const first = await fetch(`${base}/projects/limpeza/`);
    const firstJob = /\|\|\s*"([0-9a-f-]{36})"/.exec(await first.text())?.[1];
    expect(firstJob).toBeDefined();
    await writeFile(join(project, "out", "condense_plan.json"), "{}", "utf8");
    await writeFile(join(project, "out", "condensed_transcript.json"), "{}", "utf8");

    clock = 30 * 60_000;
    const reloaded = await fetch(`${base}/projects/limpeza/`);
    expect(reloaded.status).toBe(200);
    const secondJob = /\|\|\s*"([0-9a-f-]{36})"/.exec(await reloaded.text())?.[1];
    expect(secondJob).toBeDefined();
    expect(secondJob).toBe(firstJob);

    const edit = await fetch(`${base}/projects/limpeza/jobs/${firstJob}/cancel`, { method: "POST" });
    expect(edit.status).toBe(200);
    const exported = await fetch(`${base}/projects/limpeza/jobs/${firstJob}/export`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "transcript" }),
    });
    expect(exported.status, await exported.clone().text()).toBe(200);
    const download = await fetch(`${base}/projects/limpeza/jobs/${firstJob}/download/transcript`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("{}");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("resolve todos os recursos das páginas pela URL do Projeto, com e sem barra final", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-page-resources-http-"));
  const assembly = join(root, "montagem");
  const cleanup = join(root, "limpeza");
  const input = join(root, "aula.mp4");
  await mkdir(assembly);
  await createProject(assembly, blankProject("assembly-project"));
  await mkdir(cleanup);
  await writeFile(input, "media fake", "utf8");
  const source = await stat(input);
  await writeFile(sourceManifestPath(cleanup), JSON.stringify({
    path: input, size: source.size, mtimeMs: source.mtimeMs,
  }), "utf8");

  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    for (const id of ["montagem", "limpeza"]) {
      const query = "?aba=recursos";
      const withoutSlash = await fetch(`${base}/projects/${id}${query}`, { redirect: "manual" });
      expect(withoutSlash.status, id).toBe(308);
      expect(withoutSlash.headers.get("location"), id).toBe(`/projects/${id}/${query}`);
      const pageUrl = new URL(withoutSlash.headers.get("location")!, base);
      const page = await fetch(pageUrl);
      expect(page.status, id).toBe(200);
      await expectPageResources(base, pageUrl, await page.text(), id);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
