import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { sourceManifestPath } from "./session.ts";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

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
