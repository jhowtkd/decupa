import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { blankProject } from "./assembly/routes.ts";
import { createProject, loadProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

it("adiciona uma Mídia do acervo ao Projeto da Raiz pelo hash e caminho do acervo", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-media-http-"));
  const mediaRoot = join(root, "media");
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "alpha");
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const mediaId = createHash("sha256").update(input).digest("hex");
  await mkdir(join(mediaRoot, "pool"), { recursive: true });
  await writeFile(join(mediaRoot, "pool", mediaId), input);
  await writeFile(join(mediaRoot, "pool", `${mediaId}.json`), JSON.stringify({
    id: mediaId, nome: "aula.mp4", tamanho: input.byteLength, duracao: 1, criadoEm: Date.now(),
  }));
  await mkdir(projectDir, { recursive: true });
  await createProject(projectDir, blankProject("alpha-project"));

  const app = await startApp({
    projectsRoot, projectId: "alpha", port: 0, executor,
    env: { DECUPA_MEDIA_ROOT: mediaRoot },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/projects/alpha/project/media`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, mediaId }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { project: { revision: number; assembly: { sources: { path: string; sha256: string; name: string }[] } }; source: { id: string } };
    expect(body.source.id).toMatch(/^src-/);
    expect(body.project.assembly.sources).toEqual([
      expect.objectContaining({
        // O servidor guarda o caminho real (`/var` vira `/private/var` no macOS).
        path: await realpath(join(mediaRoot, "pool", mediaId)), sha256: mediaId, name: "aula.mp4",
      }),
    ]);
    expect((await loadProject(projectDir)).assembly.sources[0]).toMatchObject({ sha256: mediaId });
  } finally {
    await app.close();
  }
});

it("marca a Montagem como equipe quando há login e carrega o módulo de envio", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-media-team-"));
  const projectDir = join(root, "alpha");
  const mediaRoot = join(root, "media");
  await mkdir(projectDir, { recursive: true });
  await createProject(projectDir, blankProject("alpha-project"));
  const app = await startApp({
    projectsRoot: root, projectId: "alpha", port: 0, executor, providerConfigDir: root,
    env: { DECUPA_AUTH_PASSWORD: "senha", DECUPA_SESSION_SECRET: "segredo", DECUPA_MEDIA_ROOT: mediaRoot },
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const login = await fetch(`${base}/login`, {
      method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ senha: "senha", nome: "Ana" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(`${base}/projects/alpha/`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('name="decupa-team-mode" content="true"');
    expect(html).toContain('name="decupa-media-enabled" content="true"');
    expect(html).toContain("Adicionar Mídia");
    expect((await fetch(`${base}/projects/alpha/editor/media-upload.js`, { headers: { cookie } })).status).toBe(200);
    const native = await fetch(`${base}/projects/alpha/project/select`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    expect(native.status).toBe(409);
  } finally {
    await app.close();
  }
});
