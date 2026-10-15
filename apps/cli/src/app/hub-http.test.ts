import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EDIT_RESERVATION_FILE, EDIT_RESERVATION_TTL_MS } from "./edit-reservation.ts";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { sourceManifestPath, writeKeepList } from "./session.ts";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

it("lista Projetos da Raiz com ordenação, Reserva e problema sem carregar runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-projects-http-"));
  const now = 10_000_000;
  const recent = join(root, "recente");
  const old = join(root, "antigo");
  const cleanup = join(root, "limpeza");
  const broken = join(root, "ilegivel");
  const ignored = join(root, "nao-e-projeto");
  await Promise.all([mkdir(recent), mkdir(old), mkdir(cleanup), mkdir(broken), mkdir(ignored)]);
  await createProject(recent, blankProject("recent-id", "Projeto recente"));
  await createProject(old, blankProject("old-id", "Projeto antigo"));
  const mediaPath = join(root, "aula.mp4");
  await writeFile(mediaPath, "media", "utf8");
  const mediaStat = await stat(mediaPath);
  await writeFile(sourceManifestPath(cleanup), JSON.stringify({
    path: mediaPath, size: mediaStat.size, mtimeMs: mediaStat.mtimeMs,
    flow: "limpeza", displayName: "Aula da equipe",
  }), "utf8");
  await writeFile(join(broken, "project.json"), "{ quebrado", "utf8");
  await writeFile(join(recent, EDIT_RESERVATION_FILE), JSON.stringify({
    tabId: "tab-recente", nome: "Ana", ultimoSinal: now - 12_000,
  }), "utf8");
  await writeFile(join(old, EDIT_RESERVATION_FILE), JSON.stringify({
    tabId: "tab-antigo", nome: "Bia", ultimoSinal: now - EDIT_RESERVATION_TTL_MS - 1,
  }), "utf8");
  await utimes(join(recent, "project.json"), new Date(2026, 0, 2), new Date(2026, 0, 2));
  await utimes(sourceManifestPath(cleanup), new Date(2026, 0, 1, 12), new Date(2026, 0, 1, 12));
  await utimes(join(old, "project.json"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  await utimes(join(broken, "project.json"), new Date(2025, 0, 1), new Date(2025, 0, 1));

  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {}, now: () => now });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${base}/api/projects`);
    expect(response.status).toBe(200);
    const projects = await response.json() as Array<Record<string, unknown>>;
    expect(projects.map(project => project.id)).toEqual(["recente", "limpeza", "antigo", "ilegivel"]);
    expect(projects.find(project => project.id === "recente")).toMatchObject({
      id: "recente", nome: "Projeto recente", fluxo: "montagem",
      reserva: { nome: "Ana", ultimoSinal: now - 12_000 },
    });
    expect(projects.find(project => project.id === "limpeza")).toMatchObject({
      id: "limpeza", nome: "Aula da equipe", fluxo: "limpeza", reserva: null,
    });
    expect(projects.find(project => project.id === "antigo")).toMatchObject({
      id: "antigo", nome: "Projeto antigo", fluxo: "montagem", reserva: null,
    });
    expect(projects[0]?.atualizadoEm).toEqual(expect.any(Number));
    expect(projects.find(project => project.id === "ilegivel")).toMatchObject({
      id: "ilegivel", fluxo: "montagem", reserva: null, problema: expect.any(String),
    });
    expect(projects.some(project => project.id === "nao-e-projeto")).toBe(false);
    expect((await fetch(`${base}/api/projects`, { method: "POST" })).status).toBe(405);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("/api/projects exige sessão no modo equipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-projects-auth-http-"));
  await mkdir(join(root, "projeto"));
  await createProject(join(root, "projeto"), blankProject("project-id"));
  const app = await startApp({
    projectsRoot: root, providerConfigDir: root, port: 0, executor,
    env: { DECUPA_AUTH_PASSWORD: "senha", DECUPA_SESSION_SECRET: "segredo" },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/projects`);
    expect(response.status).toBe(401);
    const login = await fetch(`http://127.0.0.1:${app.port}/login`, {
      method: "POST", redirect: "manual",
      headers: { origin: `http://127.0.0.1:${app.port}`, "content-type": "application/json" },
      body: JSON.stringify({ senha: "senha", nome: "Ana" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(`http://127.0.0.1:${app.port}/`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain("Ana");
    expect(html).toContain('action="/logout"');
    expect(html).toContain("Configurações");
    expect(html).toContain("Templates");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("heartbeat da Reserva não altera a última alteração editorial do Projeto", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-projects-heartbeat-http-"));
  const projectDir = join(root, "projeto");
  const neighborDir = join(root, "vizinho");
  await mkdir(projectDir);
  await mkdir(neighborDir);
  await createProject(projectDir, blankProject("project-id", "Nome original"));
  await createProject(neighborDir, blankProject("neighbor-id", "Projeto vizinho"));
  const old = new Date(2026, 0, 1);
  await utimes(projectDir, old, old);
  await utimes(join(projectDir, "project.json"), old, old);
  const newer = new Date(2026, 1, 1);
  await utimes(join(neighborDir, "project.json"), newer, newer);

  let now = 10_000_000;
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {}, now: () => now });
  const base = `http://127.0.0.1:${app.port}`;
  const tabHeaders = { "x-decupa-tab": "aba-editorial", origin: base };
  try {
    const before = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; atualizadoEm: number }>;
    const beforeProject = before.find(project => project.id === "projeto")!;
    expect(before.map(project => project.id)).toEqual(["vizinho", "projeto"]);
    expect((await fetch(`${base}/projects/projeto/reservation`, { method: "POST", headers: tabHeaders })).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      now += 20_000;
      expect((await fetch(`${base}/projects/projeto/reservation/heartbeat`, { method: "POST", headers: tabHeaders })).status).toBe(200);
    }
    const afterHeartbeat = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; atualizadoEm: number }>;
    expect(afterHeartbeat.map(project => project.id)).toEqual(["vizinho", "projeto"]);
    expect(afterHeartbeat.find(project => project.id === "projeto")?.atualizadoEm).toBe(beforeProject.atualizadoEm);

    await writeFile(join(projectDir, "project.json"), JSON.stringify(blankProject("project-id", "Nome editado")), "utf8");
    const afterEdit = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; nome: string; atualizadoEm: number }>;
    const editedProject = afterEdit.find(project => project.id === "projeto")!;
    expect(editedProject.nome).toBe("Nome editado");
    expect(editedProject.atualizadoEm).toBeGreaterThan(beforeProject.atualizadoEm);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keep-list da Limpeza atualiza a última alteração editorial", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-projects-keep-http-"));
  const projectDir = join(root, "limpeza");
  const mediaPath = join(root, "aula.mp4");
  await mkdir(projectDir);
  await writeFile(mediaPath, "media", "utf8");
  const mediaStat = await stat(mediaPath);
  await writeFile(sourceManifestPath(projectDir), JSON.stringify({
    path: mediaPath, size: mediaStat.size, mtimeMs: mediaStat.mtimeMs,
    flow: "limpeza", displayName: "Aula",
  }), "utf8");
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const before = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; atualizadoEm: number }>;
    await writeKeepList(projectDir, "take-1-take-2");
    const after = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; atualizadoEm: number }>;
    expect(after.find(project => project.id === "limpeza")?.atualizadoEm)
      .toBeGreaterThan(before.find(project => project.id === "limpeza")!.atualizadoEm);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
