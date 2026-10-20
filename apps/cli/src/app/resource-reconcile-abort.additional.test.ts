import { vi } from "vitest";

const reconciliationGate = vi.hoisted(() => ({
  path: "",
  entered: null as (() => void) | null,
  gate: null as Promise<void> | null,
  error: null as Error | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = async (...args: unknown[]) => {
    if (String(args[0]) === reconciliationGate.path) {
      reconciliationGate.entered?.();
      const gate = reconciliationGate.gate;
      reconciliationGate.gate = null;
      if (gate) await gate;
      const error = reconciliationGate.error;
      reconciliationGate.error = null;
      if (error) throw error;
    }
    return Reflect.apply(actual.readdir, actual, args);
  };
  return { ...actual, readdir };
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi as vitest } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { startApp } from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  reconciliationGate.path = "";
  reconciliationGate.entered = null;
  reconciliationGate.gate = null;
  reconciliationGate.error = null;
  vitest.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("close cancela reconciliação no meio da descoberta e reconcile explícito reconstrói", async () => {
  const { ResourceLedger, initializeResourceLedger, mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
  const { fixtureAssembly } = await import("./assembly/fixture.ts");
  const root = await mkdtemp(join(tmpdir(), "resource-reconcile-abort-"));
  roots.push(root);
  const sharedMedia = join(root, "shared-media");
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "principal");
  const sha = "f".repeat(64);
  await mkdir(projectDir, { recursive: true });
  const assembly = fixtureAssembly();
  await writeFile(join(projectDir, "project.json"), JSON.stringify({
    ...blankProject("principal"),
    assembly: { ...assembly, sources: assembly.sources.map(source => ({ ...source, sha256: sha })) },
  }));

  let entered!: () => void;
  let release!: () => void;
  const atOwnersRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  reconciliationGate.path = join(sharedMedia, ".decupa", "reference-owners");
  reconciliationGate.entered = entered;
  reconciliationGate.gate = gate;

  const reconcile = ResourceLedger.prototype.reconcile as unknown as (
    this: InstanceType<typeof ResourceLedger>, options?: { signal?: AbortSignal },
  ) => Promise<void>;
  let signal: AbortSignal | undefined;
  vitest.spyOn(ResourceLedger.prototype, "reconcile").mockImplementation(async function (
    this: InstanceType<typeof ResourceLedger>, options?: { signal?: AbortSignal },
  ) {
    signal = options?.signal;
    return reconcile.call(this, options);
  });

  const app = await startApp({
    projectsRoot, projectDir, projectId: "principal", ledgerScope: "project", port: 0, autoStart: false,
    env: { DECUPA_MEDIA_ROOT: sharedMedia },
  });
  let closed = false;
  try {
    await atOwnersRead;
    let closeFinished = false;
    const closing = app.close().then(() => { closeFinished = true; closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closeFinished).toBe(false);
    const ledger = resourceLedgerForProject(projectDir);
    await expect(ledger.references(mediaKey(sha))).rejects.toThrow(/incompleto|pending|reconcil/i);
    await expect(ledger.hasWork(projectDir)).resolves.toBe(true);

    release();
    await closing;
    expect(signal?.aborted).toBe(true);
    reconciliationGate.path = "";

    await expect(readFile(join(sharedMedia, ".decupa", "references.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(ledger.references(mediaKey(sha))).resolves.toEqual([]);
    await expect(ledger.hasWork(projectDir)).resolves.toBe(false);

    await initializeResourceLedger({ root: sharedMedia, projectDir });
    await expect(ledger.references(mediaKey(sha))).resolves.toContainEqual(expect.objectContaining({
      id: `project:${projectDir}`, projectDir,
    }));
    await expect(ledger.hasWork(projectDir)).resolves.toBe(false);
  } finally {
    release();
    reconciliationGate.path = "";
    if (!closed) await app.close();
  }
});

it("close intencional libera o escopo compartilhado para outro Hub", async () => {
  const { ResourceLedger, mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
  const { fixtureAssembly } = await import("./assembly/fixture.ts");
  const root = await mkdtemp(join(tmpdir(), "resource-reconcile-close-hubs-"));
  roots.push(root);
  const sharedMedia = join(root, "shared-media");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  const projectA = join(hubA, "project-a");
  const projectB = join(hubB, "project-b");
  const sha = "b".repeat(64);
  const assembly = fixtureAssembly();
  for (const [projectDir, id] of [[projectA, "project-a"], [projectB, "project-b"]] as const) {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "project.json"), JSON.stringify({
      ...blankProject(id),
      assembly: { ...assembly, sources: assembly.sources.map(source => ({ ...source, sha256: sha })) },
    }));
  }

  let entered!: () => void;
  let release!: () => void;
  const atOwnersRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  reconciliationGate.path = join(sharedMedia, ".decupa", "reference-owners");
  reconciliationGate.entered = entered;
  reconciliationGate.gate = gate;

  const reconcile = ResourceLedger.prototype.reconcile as unknown as (
    this: InstanceType<typeof ResourceLedger>, options?: { signal?: AbortSignal },
  ) => Promise<void>;
  vitest.spyOn(ResourceLedger.prototype, "reconcile").mockImplementation(async function (
    this: InstanceType<typeof ResourceLedger>, options?: { signal?: AbortSignal },
  ) {
    return reconcile.call(this, options);
  });

  const appA = await startApp({
    projectsRoot: hubA, port: 0, autoStart: false, env: { DECUPA_MEDIA_ROOT: sharedMedia },
  });
  let appB: Awaited<ReturnType<typeof startApp>> | undefined;
  let closedA = false;
  try {
    await atOwnersRead;
    const ledgerA = resourceLedgerForProject(projectA);
    const closing = appA.close().then(() => { closedA = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closedA).toBe(false);
    await expect(ledgerA.references(mediaKey(sha))).rejects.toThrow(/incompleto|pending|reconcil/i);
    await expect(ledgerA.hasWork(projectA)).resolves.toBe(true);

    release();
    await closing;
    reconciliationGate.path = "";
    await expect(ledgerA.references(mediaKey(sha))).resolves.toEqual([]);
    await expect(ledgerA.hasWork(projectA)).resolves.toBe(false);

    appB = await startApp({
      projectsRoot: hubB, port: 0, autoStart: false, env: { DECUPA_MEDIA_ROOT: sharedMedia },
    });
    const ledgerB = resourceLedgerForProject(projectB);
    await ledgerB.reconcile();
    await expect(ledgerB.references(mediaKey(sha))).resolves.toContainEqual(expect.objectContaining({
      id: `project:${projectB}`, projectDir: projectB,
    }));
  } finally {
    release();
    reconciliationGate.path = "";
    if (appB) await appB.close();
    if (!closedA) await appA.close();
  }
});

it("erro EACCES distinto do motivo de abort continua bloqueando outro Hub", async () => {
  const { ResourceLedger, mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
  const root = await mkdtemp(join(tmpdir(), "resource-reconcile-close-eacces-"));
  roots.push(root);
  const sharedMedia = join(root, "shared-media");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  const projectA = join(hubA, "project-a");
  const projectB = join(hubB, "project-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(join(projectA, "project.json"), JSON.stringify(blankProject("project-a")));
  await writeFile(join(projectB, "project.json"), JSON.stringify(blankProject("project-b")));

  let entered!: () => void;
  let release!: () => void;
  const atOwnersRead = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const eacces = Object.assign(new Error("EACCES durante leitura do índice"), { code: "EACCES" });
  vitest.spyOn(ResourceLedger.prototype, "reconcile").mockImplementationOnce(async function () {
    entered();
    await gate;
    throw eacces;
  });

  const appA = await startApp({
    projectsRoot: hubA, port: 0, autoStart: false, env: { DECUPA_MEDIA_ROOT: sharedMedia },
  });
  let appB: Awaited<ReturnType<typeof startApp>> | undefined;
  let closedA = false;
  try {
    await atOwnersRead;
    const closing = appA.close().then(() => { closedA = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closedA).toBe(false);
    release();
    await closing;

    await expect(resourceLedgerForProject(projectA).references(mediaKey("c".repeat(64))))
      .rejects.toThrow(/EACCES/);

    vitest.restoreAllMocks();
    appB = await startApp({
      projectsRoot: hubB, port: 0, autoStart: false, env: { DECUPA_MEDIA_ROOT: sharedMedia },
    });
    const ledgerB = resourceLedgerForProject(projectB);
    await ledgerB.reconcile();
    await expect(resourceLedgerForProject(projectB).references(mediaKey("c".repeat(64))))
      .rejects.toThrow(/EACCES/);
  } finally {
    release();
    reconciliationGate.path = "";
    reconciliationGate.error = null;
    if (appB) await appB.close();
    if (!closedA) await appA.close();
  }
});

it("cancelar tokens de boot fora de ordem preserva o erro anterior do mesmo escopo", async () => {
  const { ResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const root = await mkdtemp(join(tmpdir(), "resource-reconcile-cancel-tokens-"));
  roots.push(root);
  const projectDir = join(root, "project");
  const first = new ResourceLedger(root, undefined, projectDir);
  const second = new ResourceLedger(root, undefined, projectDir);

  first.markIncomplete(new Error("erro anterior"), projectDir);
  first.markPendingReconciliation();
  second.markPendingReconciliation();
  first.cancelPendingReconciliation();
  await expect(first.references(mediaKey("f".repeat(64)))).rejects.toThrow(/reconciliação pendente/);

  second.cancelPendingReconciliation();
  await expect(first.references(mediaKey("f".repeat(64)))).rejects.toThrow(/erro anterior/);
});

it("reconciliação bem-sucedida de Hub vazio limpa abort anterior sem criar metadados", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const root = await mkdtemp(join(tmpdir(), "resource-reconcile-empty-hub-"));
  roots.push(root);
  const projectsRoot = join(root, "projects");
  const sharedMedia = join(root, "shared-media");
  await mkdir(projectsRoot, { recursive: true });

  const aborted = await initializeResourceLedger({ root: sharedMedia, projectsRoot, deferReconciliation: true });
  aborted.markIncomplete(Object.assign(new Error("varredura abortada antes"), { name: "AbortError" }), projectsRoot);
  const nextBoot = await initializeResourceLedger({ root: sharedMedia, projectsRoot, deferReconciliation: true });

  await expect(nextBoot.references(mediaKey("f".repeat(64)))).rejects.toThrow(/incompleto/);
  await nextBoot.reconcile();
  await expect(nextBoot.references(mediaKey("f".repeat(64)))).resolves.toEqual([]);
  await expect(readdir(projectsRoot)).resolves.toEqual([]);
  await expect(readFile(join(sharedMedia, ".decupa", "references.json"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
});
