import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

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
    for (const asset of ["page.css", "page.js", "project-path.js", "editor/rail.js"]) {
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
  await mkdir(join(root, "arquivo")).then(() => undefined);
  const valid = join(root, "valido");
  await mkdir(valid);
  await createProject(valid, blankProject("valid-project"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    for (const id of ["ausente", "%2e%2e", "a%2fb", "a%2Fb", "com espaço", ".", ".."] ) {
      expect((await fetch(`${base}/projects/${id}/`)).status, id).toBe(404);
    }
    expect((await fetch(`${base}/projects/arquivo/`)).status).toBe(404);
    expect((await fetch(`${base}/projects/valido//`)).status).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
