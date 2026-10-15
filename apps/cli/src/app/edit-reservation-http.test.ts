import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

it("a primeira aba obtém a Reserva de Edição e ela fica persistida no Projeto", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-http-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  await createProject(dir, blankProject("alpha-project"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/projects/alpha/reservation`, {
      method: "POST",
      headers: { "x-decupa-tab": "tab-a" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reserva: { tabId: "tab-a", nome: expect.any(String), ultimoSinal: expect.any(Number) },
    });
    await expect(access(join(dir, "edit-reservation.json"))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "edit-reservation.json"), "utf8"))).toMatchObject({
      tabId: "tab-a",
      nome: expect.any(String),
      ultimoSinal: expect.any(Number),
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("o portão recusa alterações, a Reserva expira e outra aba pode assumi-la", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-gate-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  await createProject(dir, blankProject("alpha-project"));
  let agora = 1_000_000;
  const now = () => agora;
  const options = { projectsRoot: root, port: 0, executor, env: {}, now };
  const first = await startApp(options);
  const second = await startApp(options);
  const one = `http://127.0.0.1:${first.port}`;
  const two = `http://127.0.0.1:${second.port}`;
  try {
    expect((await fetch(`${one}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);

    const occupied = await fetch(`${two}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    });
    expect(occupied.status).toBe(409);
    expect(await occupied.json()).toMatchObject({ dono: { ultimoSinal: agora } });

    const blocked = await fetch(`${two}/projects/alpha/project/input`, {
      method: "POST",
      headers: { "x-decupa-tab": "tab-b", "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, kind: "brief", text: "não deve gravar", targetSeconds: 60 }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ dono: { ultimoSinal: agora } });
    expect((await fetch(`${two}/projects/alpha/project`)).status).toBe(200);

    agora += 90_001;
    const acquired = await fetch(`${two}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    });
    expect(acquired.status).toBe(200);
    const changed = await fetch(`${two}/projects/alpha/project/input`, {
      method: "POST",
      headers: { "x-decupa-tab": "tab-b", "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, kind: "brief", text: "pode gravar", targetSeconds: 60 }),
    });
    expect(changed.status).toBe(200);
    expect((await fetch(`${one}/projects/alpha/reservation/heartbeat`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(409);

    const released = await fetch(`${two}/projects/alpha/reservation/release`, {
      method: "POST", body: JSON.stringify({ tabId: "tab-b" }),
    });
    expect(released.status).toBe(200);
    expect((await fetch(`${one}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("aplica a mesma Reserva ao runtime legado de Limpeza", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-cleanup-"));
  let agora = 2_000_000;
  const app = await startApp({
    input: join(root, "fala.mp4"), workDir: join(root, "projeto"), autoStart: false,
    port: 0, executor, env: {}, now: () => agora,
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);
    const denied = await fetch(`${base}/jobs/${app.jobId}/cancel`, { method: "POST" });
    expect(denied.status).toBe(409);
    expect((await fetch(`${base}/jobs/${app.jobId}/cancel`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);
    agora += 90_001;
    expect((await fetch(`${base}/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    })).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
