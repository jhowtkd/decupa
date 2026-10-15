import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

it("cria Montagem nova pelo caminho usado pelo editor na mesma Raiz", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-root-new-"));
  const existing = join(root, "existente");
  await mkdir(existing);
  await createProject(existing, blankProject("existing-project"));
  const app = await startApp({ projectsRoot: root, projectId: "existente", port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${base}/projects/existente/project/new`, { method: "POST", body: "{}" });
    expect(response.status).toBe(201);
    const body = await response.json() as { url: string; dir: string };
    const id = body.url.match(/^\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/$/)?.[1];
    expect(id).toMatch(/^projeto-[A-Za-z0-9]{4}$/);
    expect(body.dir).toBe(join(root, id!));
    expect(dirname(body.dir)).toBe(root);
    expect(basename(body.dir)).toBe(id);
    await access(join(body.dir, "project.json"));
    expect(JSON.parse(await readFile(join(body.dir, "project.json"), "utf8"))).toMatchObject({ id: expect.any(String) });
    expect((await fetch(`${base}${body.url}`)).status).toBe(200);
    expect((await fetch(`${base}${body.url}project`)).status).toBe(200);

    const rootResponse = await fetch(`${base}/project/new`, { method: "POST", body: "{}" });
    expect(rootResponse.status).toBe(201);
    const rootBody = await rootResponse.json() as { url: string; dir: string };
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
