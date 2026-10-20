import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCoordinator } from "@decupa/coordinator";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { initializeResourceLedger } from "./resource-ledger.ts";
import { listProjectRootEntries } from "./project-root.ts";
import { EDIT_RESERVATION_FILE } from "./edit-reservation.ts";
import { startApp } from "./server.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(label: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function fixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

it("índice de referências pendente não transforma projeto ocioso em trabalho ocupado", async () => {
  const root = await fixtureRoot("hub-pending-index-");
  const projectDir = join(root, "projeto");
  await mkdir(projectDir);
  await createProject(projectDir, blankProject("project-id", "Projeto"));
  const ledger = await initializeResourceLedger({
    root: join(root, "media"), projectsRoot: root, deferReconciliation: true,
  });
  try {
    expect(await ledger.hasWork(projectDir)).toBe(true);
    const projects = await listProjectRootEntries(root, () => 10_000, { runtime: async () => undefined });
    expect(projects[0]?.activity).toMatchObject({ busy: false, queuePosition: null, actions: { cancel: false } });
  } finally {
    ledger.cancelPendingReconciliation();
    await rm(root, { recursive: true, force: true });
  }
});

it("combina runtime, correções pendentes, revisão aprovada e reserva nas ações do Hub", async () => {
  const root = await fixtureRoot("hub-activity-actions-");
  const now = 50_000;
  const busyDir = join(root, "ocupado");
  const correctionDir = join(root, "correcao");
  const approvedDir = join(root, "aprovado");
  await Promise.all([mkdir(busyDir), mkdir(correctionDir), mkdir(approvedDir)]);

  const busyProject = blankProject("busy-id", "Ocupado");
  await createProject(busyDir, busyProject);
  const correctionProject = blankProject("correction-id", "Correção pendente");
  correctionProject.assembly.sources = [{
    id: "source-1", name: "fala.wav", path: join(root, "fala.wav"), sha256: "a".repeat(64),
    size: 5, mtimeMs: 1, durationSeconds: 10, hasVideo: false, hasAudio: true, included: true,
    role: "speech", fps: null, width: null, height: null,
  }];
  correctionProject.revision = 4;
  correctionProject.previewRevision = 4;
  correctionProject.finalApprovedRevision = 4;
  correctionProject.corrections = [{
    id: "correction-1", sourceId: "source-1", start: 0, end: 1, text: "ajustada", status: "pending", words: [],
  }];
  await createProject(correctionDir, correctionProject);
  const approvedProject = blankProject("approved-id", "Aprovado com reserva");
  approvedProject.revision = 7;
  approvedProject.previewRevision = 7;
  approvedProject.finalApprovedRevision = 7;
  approvedProject.previewArtifact = {
    revision: 7,
    assemblySha256: createHash("sha256").update(JSON.stringify(approvedProject.assembly)).digest("hex"),
    relativePath: "preview.mp4",
    sha256: "b".repeat(64),
  };
  await writeFile(join(approvedDir, "preview.mp4"), "preview");
  await createProject(approvedDir, approvedProject);

  try {
    const options = {
      runtime: async (id: string) => id === "ocupado"
        ? { busy: true, cancellable: true, operation: { stage: "aligning", error: "alinhamento falhou" }, startedAt: now - 500 }
        : { busy: false },
    };
    const unreserved = await listProjectRootEntries(root, () => now, options);
    expect(unreserved.find((project) => project.id === "aprovado")?.activity?.actions.export).toBe(true);
    await writeFile(join(approvedDir, EDIT_RESERVATION_FILE), JSON.stringify({
      tabId: "editor-tab", nome: "Ana", ultimoSinal: now - 1_000,
    }));
    const projects = await listProjectRootEntries(root, () => now, options);
    const activity = (id: string) => projects.find((project) => project.id === id)?.activity;

    expect(activity("ocupado")).toMatchObject({ busy: true, elapsedMs: 500, actions: { cancel: true, resume: false, export: false } });
    expect(activity("ocupado")?.error).toContain("alinhamento falhou");

    expect(activity("correcao")).toMatchObject({ revision: 4, busy: false, actions: { resume: false, export: false } });
    expect(activity("correcao")?.approval.toLocaleLowerCase()).toContain("aprovada");

    expect(projects.find((project) => project.id === "aprovado")?.reservation).toMatchObject({ nome: "Ana" });
    expect(activity("aprovado")).toMatchObject({
      revision: 7, busy: false, actions: { resume: false, cancel: false, export: false },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("/api/projects mostra posição e etapa dos dois projetos esperando na fila global", async () => {
  const root = await fixtureRoot("hub-queue-http-");
  const coordinatorDir = join(root, "global-queue");
  const firstDir = join(root, "primeiro");
  const secondDir = join(root, "segundo");
  await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
  await createProject(firstDir, blankProject("first-id", "Primeiro"));
  await createProject(secondDir, blankProject("second-id", "Segundo"));

  const coordinator = createFileCoordinator(coordinatorDir, { limit: 1, pollMs: 5 });
  const readQueue = async () => {
    if (!coordinator.queue) throw new Error("FileCoordinator não disponibilizou queue()");
    return coordinator.queue();
  };
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const blocker = coordinator.withSlot({ stage: "fixture-blocker" }, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await blockerStarted.promise;
    first = coordinator.withSlot({ stage: "transcription", projectId: "primeiro" }, () => undefined);
    await waitUntil("first project in queue", async () => (await readQueue()).length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    second = coordinator.withSlot({ stage: "rendering", projectId: "segundo" }, () => undefined);
    await waitUntil("two projects in queue", async () => (await readQueue()).length === 2);
    expect(await readQueue()).toMatchObject([
      { projectId: "primeiro", stage: "transcription", position: 1 },
      { projectId: "segundo", stage: "rendering", position: 2 },
    ]);

    app = await startApp({ projectsRoot: root, coordinatorDir, port: 0, autoStart: false, executor: { async run() { return { code: 0, stdout: "", stderr: "" }; } }, env: {} });
    const response = await fetch(`http://127.0.0.1:${app.port}/api/projects`);
    expect(response.status).toBe(200);
    const projects = await response.json() as Array<{ id: string; atividade: { queuePosition: number | null; stage: string; busy: boolean } }>;
    expect(projects.find((project) => project.id === "primeiro")?.atividade).toMatchObject({
      queuePosition: 1, stage: "Transcrever áudio", busy: true,
    });
    expect(projects.find((project) => project.id === "segundo")?.atividade).toMatchObject({
      queuePosition: 2, stage: "Renderizar prévia", busy: true,
    });
  } finally {
    await app?.close();
    releaseBlocker.resolve();
    await Promise.all([blocker, ...(first ? [first] : []), ...(second ? [second] : [])]);
    await rm(root, { recursive: true, force: true });
  }
});
