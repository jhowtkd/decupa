import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { File } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { EDIT_RESERVATION_FILE, EDIT_RESERVATION_TTL_MS } from "./edit-reservation.ts";
import { ResumableMediaUpload } from "./assembly/editor/media-upload.js";
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

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
}

/** O cliente real da gaveta, apontado para o servidor de teste: o que o navegador faz. */
function enviarPeloHub(base: string, nome: string, bytes: Uint8Array): Promise<{ mediaId: string; deduplicado: boolean }> {
  const upload = new ResumableMediaUpload({
    fetchImpl: (url: string, init?: RequestInit) => fetch(`${base}${url}`, init),
    storage: memoryStorage(),
  });
  return upload.start(new File([bytes], nome, { lastModified: 1 })) as Promise<{ mediaId: string; deduplicado: boolean }>;
}

it("envia Mídias com o cliente do hub e cria o Projeto com elas", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-gaveta-http-"));
  const projectsRoot = join(root, "projetos");
  await mkdir(projectsRoot);
  const app = await startApp({
    projectsRoot, port: 0, autoStart: false, executor, env: { DECUPA_MEDIA_ROOT: join(root, "midias") },
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const aula = await enviarPeloHub(base, "aula.mp4", await readFile(join(FIXTURES, "clip.mp4")));
    const fala = await enviarPeloHub(base, "fala.wav", await readFile(join(FIXTURES, "tone-gap.wav")));
    expect(aula.mediaId).toMatch(/^[0-9a-f]{64}$/);
    expect(fala.mediaId).not.toBe(aula.mediaId);

    const criar = (body: unknown) => fetch(`${base}/project/new`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    // A regra que a gaveta espelha: Limpeza aceita exatamente uma Mídia.
    expect((await criar({ nome: "Limpeza dupla", fluxo: "limpeza", midias: [aula.mediaId, fala.mediaId] })).status).toBe(400);

    const created = await criar({ nome: "Aula da equipe", fluxo: "montagem", midias: [aula.mediaId, fala.mediaId] });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; url: string };
    expect(body).toEqual({ id: expect.any(String), url: `/projects/${body.id}/` });
    const projects = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string; nome: string; fluxo: string }>;
    expect(projects).toContainEqual(expect.objectContaining({ id: body.id, nome: "Aula da equipe", fluxo: "montagem" }));
    expect((await fetch(`${base}${body.url}`)).status).toBe(200);

    const limpeza = await criar({ nome: "Aula limpa", fluxo: "limpeza", midias: [aula.mediaId] });
    expect(limpeza.status).toBe(201);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("o cliente do hub recebe o status de Mídia inválida do servidor", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-gaveta-invalid-http-"));
  const app = await startApp({
    projectsRoot: join(root, "projetos"), port: 0, autoStart: false, executor, env: { DECUPA_MEDIA_ROOT: join(root, "midias") },
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    await expect(enviarPeloHub(base, "quebrado.bin", Buffer.from("não é vídeo"))).rejects.toMatchObject({ status: 422 });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("o cliente do hub recebe o status de Mídia acima do máximo do servidor", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-gaveta-limit-http-"));
  const app = await startApp({
    projectsRoot: join(root, "projetos"), port: 0, autoStart: false, executor,
    env: { DECUPA_MEDIA_ROOT: join(root, "midias"), DECUPA_UPLOAD_MAX_GB: "0.000001" },
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    await expect(enviarPeloHub(base, "grande.mp4", new Uint8Array(100_000))).rejects.toMatchObject({ status: 413 });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("serve a gaveta do hub com os módulos que a página importa e os IDs que o script procura", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-gaveta-static-http-"));
  const app = await startApp({
    projectsRoot: root, port: 0, autoStart: false, executor, env: { DECUPA_MEDIA_ROOT: join(root, "midias") },
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<meta name="decupa-media-enabled" content="true">');
    expect(html).toContain('<dialog id="newProjectDialog"');
    const script = await (await fetch(`${base}/hub/page.js`)).text();
    const ids = new Set([...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]));
    expect(ids.size).toBeGreaterThan(10);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    for (const path of ["/hub/gaveta.js", "/hub/media-upload.js"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
    }
    expect((await fetch(`${base}/hub/nao-existe.js`)).status).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
