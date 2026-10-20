import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { startApp } from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function gateReconciliation() {
  const { ResourceLedger } = await import("./resource-ledger.ts");
  const reconcile = ResourceLedger.prototype.reconcile as (this: InstanceType<typeof ResourceLedger>, options?: { signal?: AbortSignal }) => Promise<void>;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(ResourceLedger.prototype, "reconcile").mockImplementation(async function (
    this: InstanceType<typeof ResourceLedger>, options?: { signal?: AbortSignal },
  ) {
    entered();
    await gate;
    await reconcile.call(this, options);
  });
  return { started, release };
}

async function expectLedgerPendingWhileBooting(opts: {
  projectDir: string;
  start: () => Promise<{ port: number; close(): Promise<void> }>;
}) {
  const { resourceLedgerForProject, mediaKey } = await import("./resource-ledger.ts");
  const gate = await gateReconciliation();
  let app: Awaited<ReturnType<typeof opts.start>> | undefined;
  let startup: ReturnType<typeof opts.start> | undefined;
  let timedOut: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    const boot = opts.start();
    startup = boot;
    await gate.started;
    app = await Promise.race([
      boot,
      new Promise<never>((_, reject) => { timedOut = setTimeout(() => reject(new Error("boot waited for reconcile")), 5000); }),
    ]);
    if (timedOut) clearTimeout(timedOut);
    const ledger = resourceLedgerForProject(opts.projectDir);

    const health = await fetch(`http://127.0.0.1:${app.port}/healthz`);
    expect(health.status).toBe(200);
    await expect(ledger.references(mediaKey("f".repeat(64)))).rejects.toThrow(/incompleto|pending|reconcil/i);
    await expect(ledger.hasWork(opts.projectDir)).resolves.toBe(true);

    closing = app.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    await expect(ledger.references(mediaKey("f".repeat(64)))).rejects.toThrow(/incompleto|pending|reconcil/i);
    await expect(ledger.hasWork(opts.projectDir)).resolves.toBe(true);
    gate.release();
    await closing;
    await expect(ledger.references(mediaKey("f".repeat(64)))).resolves.toEqual([]);
    await expect(ledger.hasWork(opts.projectDir)).resolves.toBe(false);
    await ledger.reconcile();
    await expect(ledger.references(mediaKey("f".repeat(64)))).resolves.toEqual([]);
  } finally {
    gate.release();
    if (timedOut) clearTimeout(timedOut);
    if (startup) app ??= await startup.catch(() => undefined);
    if (closing) await closing;
    else if (app && !closed) await app.close();
  }
}

it("Hub fica pronto enquanto reconcilia e close aguarda o reconcile real", async () => {
  const root = await tempRoot("resource-boot-hub-");
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "project-a");
  await mkdir(projectDir, { recursive: true });
  await createProject(projectDir, blankProject("project-a"));
  await expectLedgerPendingWhileBooting({
    projectDir,
    start: () => startApp({ projectsRoot, projectDir, projectId: "project-a", port: 0, autoStart: false, env: {} }),
  });
});

it("projeto avulso fica pronto durante reconciliação em DECUPA_MEDIA_ROOT compartilhado", async () => {
  const root = await tempRoot("resource-boot-standalone-");
  const sharedMedia = join(root, "shared-media");
  const projectDir = join(root, "standalone");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "project.json"), JSON.stringify(blankProject("standalone")));

  await expectLedgerPendingWhileBooting({
    projectDir,
    start: () => startApp({ projectDir, port: 0, env: { DECUPA_MEDIA_ROOT: sharedMedia } }),
  });

  const { initializeResourceLedger } = await import("./resource-ledger.ts");
  await initializeResourceLedger({ root: sharedMedia, projectDir });
  await expect(readFile(join(root, ".decupa", "references.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const ownerIndex = JSON.parse(await readFile(join(sharedMedia, ".decupa", "references.json"), "utf8")) as { entries: unknown[] };
  expect(ownerIndex.entries).toHaveLength(1);
});

it("perda do índice compartilhado permite reconstrução de A/B e avulso sem criar ledger no pai", async () => {
  const root = await tempRoot("resource-boot-shared-root-");
  const sharedMedia = join(root, "shared-media");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  const projectA = join(hubA, "project-a");
  const projectB = join(hubB, "project-b");
  const standalone = join(root, "standalone");
  const sha = "a".repeat(64);
  const assembly = fixtureAssembly();
  for (const dir of [projectA, projectB, standalone]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({
      ...blankProject(dir === standalone ? "standalone" : dir === projectA ? "project-a" : "project-b"),
      assembly: { ...assembly, sources: assembly.sources.map(source => ({ ...source, sha256: sha })) },
    }));
  }
  const { mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
  const waitForReferences = async (dir: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await resourceLedgerForProject(dir).references(mediaKey(sha));
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/incompleto/.test(error.message) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
  };
  const bootHub = async (projectsRoot: string) => {
    const app = await startApp({ projectsRoot, port: 0, autoStart: false, env: { DECUPA_MEDIA_ROOT: sharedMedia } });
    await waitForReferences(projectsRoot === hubA ? projectA : projectB);
    await app.close();
  };
  const bootStandalone = async () => {
    const app = await startApp({ projectDir: standalone, port: 0, env: { DECUPA_MEDIA_ROOT: sharedMedia } });
    await waitForReferences(standalone);
    await app.close();
  };

  await bootHub(hubA);
  await bootHub(hubB);
  await bootStandalone();
  await rm(join(sharedMedia, ".decupa", "references.json"));
  await bootHub(hubA);
  await bootHub(hubB);
  const ledger = resourceLedgerForProject(projectB);

  await expect(ledger.references(mediaKey(sha))).resolves.toHaveLength(3);
  await expect(readFile(join(root, ".decupa", "references.json"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
});
