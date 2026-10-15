import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hashFile } from "@decupa/media";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";
import { cleanupWorkDir } from "./session.ts";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

async function seedHeavyAssembly(): Promise<{ root: string; dir: string; mediaPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-heavy-root-"));
  const dir = join(root, "alpha");
  const mediaPath = join(FIXTURES, "clip.mp4");
  await mkdir(dir);
  const mediaSha = await hashFile(mediaPath);
  const project = blankProject("alpha-project");
  project.revision = 1;
  const assembly = fixtureAssembly();
  project.assembly = {
    ...assembly,
    sources: assembly.sources.map((source) => ({ ...source, path: mediaPath, sha256: mediaSha })),
    tracks: assembly.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => track.kind === "Audio" || track.name === "V1"
        ? { ...clip, durationFrames: 75 } : clip),
    })),
  };
  await createProject(dir, project);
  await mkdir(join(dir, "hardware-proof"));
  await writeFile(join(dir, "hardware-proof", "profile.json"), JSON.stringify({ version: 2, profile: "software" }));
  return { root, dir, mediaPath };
}

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

it("GET da Reserva não devolve o tabId persistido para outro cliente", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-public-http-"));
  const dir = join(root, "alpha");
  await mkdir(dir); await createProject(dir, blankProject("alpha-project"));
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {} });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-secreta" },
    })).status).toBe(200);
    const body = await (await fetch(`${base}/projects/alpha/reservation`)).json() as {
      dono: Record<string, unknown>; minha: boolean;
    };
    expect(body).not.toHaveProperty("reserva");
    expect(body).not.toHaveProperty("reservation");
    expect(body.dono).not.toHaveProperty("tabId");
    expect(body.dono).toMatchObject({ nome: expect.any(String), ultimoSinal: expect.any(Number) });
    expect(body.minha).toBe(false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("cliente sem aba altera Projeto livre, é bloqueado pela Reserva e volta após expiração", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-no-tab-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  await createProject(dir, blankProject("alpha-project"));
  let agora = 1_000_000;
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: {}, now: () => agora });
  const base = `http://127.0.0.1:${app.port}`;
  const mutation = (baseRevision = 1) => fetch(`${base}/projects/alpha/project/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision, kind: "brief", text: "cliente externo", targetSeconds: 60 }),
  });
  try {
    expect((await mutation(0)).status).toBe(200);
    expect((await fetch(`${base}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);

    const blocked = await mutation();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ dono: { nome: expect.any(String), ultimoSinal: agora } });

    agora += 90_001;
    expect((await mutation()).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("Assumir Edição transfere a Reserva e a aba anterior descobre no sinal", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-take-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  await createProject(dir, blankProject("alpha-project"));
  let agora = 1_500_000;
  const first = await startApp({ projectsRoot: root, port: 0, executor, env: {}, now: () => agora });
  const second = await startApp({ projectsRoot: root, port: 0, executor, env: {}, now: () => agora });
  const one = `http://127.0.0.1:${first.port}`;
  const two = `http://127.0.0.1:${second.port}`;
  try {
    expect((await fetch(`${one}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);

    agora += 12_000;
    const taken = await fetch(`${two}/projects/alpha/reservation/take`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ reserva: { tabId: "tab-b", ultimoSinal: agora, assumidoEm: agora } });

    const oldHeartbeat = await fetch(`${one}/projects/alpha/reservation/heartbeat`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    });
    expect(oldHeartbeat.status).toBe(409);
    expect(await oldHeartbeat.json()).toMatchObject({ dono: { nome: expect.any(String), ultimoSinal: agora, assumidoEm: agora } });
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("dois servidores compartilham a Reserva e liberam leitura e Range no Modo Leitura", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-readonly-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  const source = fixtureAssembly().sources[0]!;
  const mediaPath = join(process.cwd(), "tests/fixtures/generated/clip.mp4");
  const mediaStat = await stat(mediaPath);
  const project = blankProject("alpha-project");
  project.assembly.sources = [{
    ...source, id: "source-a", path: mediaPath, sha256: await hashFile(mediaPath),
    size: mediaStat.size, mtimeMs: mediaStat.mtimeMs,
  }];
  await createProject(dir, project);
  let agora = 1_750_000;
  const options = { projectsRoot: root, port: 0, executor, env: {}, now: () => agora };
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

    const projectResponse = await fetch(`${two}/projects/alpha/project`, {
      headers: { "x-decupa-tab": "tab-b" },
    });
    expect(projectResponse.status).toBe(200);

    const media = await fetch(`${two}/projects/alpha/project/media/source-a`, {
      headers: { "x-decupa-tab": "tab-b", range: "bytes=0-3" },
    });
    expect(media.status).toBe(206);
    expect((await media.arrayBuffer()).byteLength).toBe(4);
  } finally {
    await first.close();
    await second.close();
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

it("a Reserva vale para a Limpeza servida sob /projects/:id no modo Raiz", async () => {
  const root = await mkdtemp(join(tmpdir(), "edit-reservation-cleanup-root-"));
  const input = join(root, "aula.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), input);
  const workDir = cleanupWorkDir(input);
  const id = basename(workDir);
  const app = await startApp({ input, projectsRoot: root, projectDir: workDir, projectId: id, port: 0, autoStart: false, executor });
  const base = `http://127.0.0.1:${app.port}`;
  const project = `${base}/projects/${id}`;
  const tab = (tabId: string) => ({ origin: base, "x-decupa-tab": tabId, "content-type": "application/json" });
  try {
    // No modo Raiz, `app.jobId` é o id do Projeto; o job da Limpeza vem na página.
    const jobId = /get\("job"\)\s*\|\|\s*"([^"]+)"/.exec(await (await fetch(`${project}/`)).text())?.[1];
    expect(jobId).toBeTruthy();
    expect((await fetch(`${project}/reservation`, { method: "POST", headers: tab("A") })).status).toBe(200);
    const cancel = await fetch(`${project}/jobs/${jobId}/cancel`, { method: "POST", headers: tab("B") });
    expect(cancel.status).toBe(409);
    expect((await cancel.json() as { dono: { nome: string } }).dono.nome).toBeTruthy();
    // Modo Leitura: a outra aba continua lendo o job e a página.
    expect((await fetch(`${project}/jobs/${jobId}`, { headers: { "x-decupa-tab": "B" } })).status).toBe(200);
    expect((await fetch(`${project}/edit-reservation-ui.js`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("prévia já iniciada termina e grava depois que outra aba assume a Reserva", async () => {
  const { root, dir, mediaPath } = await seedHeavyAssembly();

  let started!: () => void;
  const heavyStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const heavyGate = new Promise<void>((resolve) => { release = resolve; });
  const executor = {
    async run(call: { command: string; cwd?: string; env?: Record<string, string | undefined> }) {
      if (call.command === "python3") {
        started();
        await heavyGate;
        await copyFile(mediaPath, join(call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? dir, "reference.mp4"));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const app = await startApp({
    projectsRoot: root, port: 0, coordinatorDir: join(root, "coordinator"), executor, env: {},
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);

    const preview = fetch(`${base}/projects/alpha/project/preview`, {
      method: "POST",
      headers: { "x-decupa-tab": "tab-a", "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 1 }),
    });
    await heavyStarted;

    const taken = await fetch(`${base}/projects/alpha/reservation/take`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    });
    expect(taken.status).toBe(200);
    release();

    const previewResponse = await preview;
    expect(previewResponse.status, await previewResponse.text()).toBe(200);
    const completed = await (await fetch(`${base}/projects/alpha/project`, {
      headers: { "x-decupa-tab": "tab-b" },
    })).json() as { project: { previewArtifact: { revision: number; relativePath: string } | null } };
    expect(completed.project.previewArtifact).toMatchObject({ revision: 1, relativePath: join("rev-1", "reference.mp4") });
    await expect(access(join(dir, "rev-1", "reference.mp4"))).resolves.toBeUndefined();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("a aba que assume a Reserva pode cancelar a prévia em curso", async () => {
  const { root, dir, mediaPath } = await seedHeavyAssembly();
  let started!: () => void;
  const heavyStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const heavyGate = new Promise<void>((resolve) => { release = resolve; });
  const executor = {
    async run(call: { command: string; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }) {
      if (call.command === "python3") {
        started();
        const aborted = new Promise<never>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("render cancelado")), { once: true });
        });
        await Promise.race([heavyGate, aborted]);
        if (call.signal?.aborted) throw new Error("render cancelado");
        await copyFile(mediaPath, join(call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? dir, "reference.mp4"));
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const app = await startApp({
    projectsRoot: root, port: 0, coordinatorDir: join(root, "coordinator"), executor, env: {},
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    expect((await fetch(`${base}/projects/alpha/reservation`, {
      method: "POST", headers: { "x-decupa-tab": "tab-a" },
    })).status).toBe(200);
    const preview = fetch(`${base}/projects/alpha/project/preview`, {
      method: "POST",
      headers: { "x-decupa-tab": "tab-a", "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 1 }),
    });
    await heavyStarted;

    expect((await fetch(`${base}/projects/alpha/reservation/take`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    })).status).toBe(200);
    const cancel = await fetch(`${base}/projects/alpha/project/cancel`, {
      method: "POST", headers: { "x-decupa-tab": "tab-b" },
    });
    expect(cancel.status).toBe(200);
    release();
    await preview;

    const snapshot = await (await fetch(`${base}/projects/alpha/project`, {
      headers: { "x-decupa-tab": "tab-b" },
    })).json() as { project: { previewArtifact: unknown; revision: number }; operation: { stage: string } };
    expect(snapshot.project.previewArtifact).toBeNull();
    expect(snapshot.project.revision).toBe(1);
    expect(snapshot.operation.stage).toBe("cancelled");
    await expect(access(join(dir, "rev-1", "reference.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
