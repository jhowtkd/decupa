import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

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
    for (const body of [{ nome: "  ", fluxo: "montagem" }, { nome: "Teste", fluxo: "desconhecido" }, { nome: "Teste", fluxo: "limpeza" }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(await readdir(root)).toEqual([]);
  } finally {
    await app.close();
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
