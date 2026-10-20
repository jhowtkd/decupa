import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject, loadProject, saveProject } from "./assembly/store.ts";

const renameFailure = vi.hoisted(() => ({ failAt: 0, calls: 0, rollbackFailAt: 0, rollbackCalls: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).includes("/cleanup-trash/")) {
        renameFailure.calls++;
        if (renameFailure.failAt !== 0 && renameFailure.calls === renameFailure.failAt) throw new Error("cleanup interrupted");
      } else if (String(args[0]).includes("/cleanup-trash/")) {
        renameFailure.rollbackCalls++;
        if (renameFailure.rollbackFailAt !== 0 && renameFailure.rollbackCalls === renameFailure.rollbackFailAt) {
          throw new Error("cleanup rollback interrupted");
        }
      }
      return actual.rename(...args);
    }),
  };
});

import { CleanedResourceError, initializeResourceLedger, mediaKey, withResourceWork } from "./resource-ledger.ts";
import { confirmProjectCleanup, planProjectCleanup, reconcileProjectCleanups } from "./project-cleanup.ts";

const roots: string[] = [];
afterEach(async () => {
  renameFailure.failAt = 0; renameFailure.calls = 0; renameFailure.rollbackFailAt = 0; renameFailure.rollbackCalls = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-additional-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "one");
  const now = 30 * 86_400_000;
  const sha = "c".repeat(64);
  const sourcePath = join(projectDir, "imports", "source.mp4");
  await mkdir(join(projectDir, "imports"), { recursive: true });
  await writeFile(sourcePath, "source media");
  await writeFile(join(projectDir, "project.json"), JSON.stringify({
    revision: 1,
    finalApprovedRevision: 1,
    lifecycle: { state: "entregue", revision: 1, enteredAt: { entregue: now - 8 * 86_400_000 } },
    assembly: { sources: [{ sha256: sha, path: sourcePath }] },
  }));
  const ledger = await initializeResourceLedger({ root, projectsRoot, now: () => now, env: {} });
  const opts = { ledger, now: () => now, env: {} };
  return { root, projectsRoot, projectDir, sourcePath, sha, ledger, opts };
}

async function confirm(planId: string, dir: string, opts: Awaited<ReturnType<typeof fixture>>["opts"]) {
  return confirmProjectCleanup(dir, { planId, confirmed: true, acknowledgeOffline: true }, opts);
}

async function publicationFixture() {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-publication-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectA = join(projectsRoot, "source-project");
  const projectB = join(projectsRoot, "new-project");
  const sourcePath = join(projectA, "imports", "source.mp4");
  const poolPath = join(root, "pool", "e".repeat(64));
  const now = 40 * 86_400_000;
  const sha = "e".repeat(64);
  await mkdir(join(projectA, "imports"), { recursive: true });
  await mkdir(join(projectB), { recursive: true });
  await mkdir(join(root, "pool"), { recursive: true });
  await writeFile(sourcePath, "source media");
  await writeFile(poolPath, "preserved pool media");
  const ledger = await initializeResourceLedger({ root, projectsRoot, now: () => now, env: {} });

  const source = { ...fixtureAssembly().sources[0]!, id: "camera", sha256: sha, path: sourcePath, name: "source.mp4" };
  const delivered = blankProject("source-project");
  delivered.revision = 1;
  delivered.assembly = { ...fixtureAssembly(), revision: 1, sources: [source], tracks: [
    { kind: "Video", name: "V1", clips: [] }, { kind: "Video", name: "V2", clips: [] }, { kind: "Audio", name: "A1", clips: [] },
  ] };
  delivered.finalApprovedRevision = 1;
  delivered.lifecycle = { state: "entregue", revision: 1, enteredAt: { entregue: now - 8 * 86_400_000 } };
  await createProject(projectA, delivered);
  await createProject(projectB, blankProject("new-project"));
  const opts = { ledger, now: () => now, env: {} };
  const plan = await planProjectCleanup(projectA, opts);
  await confirm(plan.planId, projectA, opts);
  return { projectB, sourcePath, poolPath, sha };
}

function addSourceAt(path: string) {
  return (current: Awaited<ReturnType<typeof loadProject>>) => {
    const revision = current.revision + 1;
    const source = { ...fixtureAssembly().sources[0]!, id: "camera", sha256: "e".repeat(64), path, name: "source.mp4" };
    return { ...current, revision, assembly: { ...current.assembly, revision, sources: [source] } };
  };
}

it.each(["new external reference", "new cleanup file", "new in-progress work"] as const)(
  "refuses a stale cleanup plan after %s appears",
  async change => {
    const f = await fixture();
    const plan = await planProjectCleanup(f.projectDir, f.opts);

    if (change === "new external reference") {
      await f.ledger.register({ id: "package:other-project", kind: "package", projectDir: join(f.projectsRoot, "other") }, [mediaKey(f.sha)]);
    } else if (change === "new cleanup file") {
      await mkdir(join(f.projectDir, ".decupa", "metrics"), { recursive: true });
      await writeFile(join(f.projectDir, ".decupa", "metrics", "after-plan.jsonl"), "new journal");
    } else {
      await f.ledger.register({
        id: "in-progress:render:after-plan", kind: "in-progress", projectDir: f.projectDir, pid: process.pid,
      }, [mediaKey(f.sha)]);
    }

    await expect(confirm(plan.planId, f.projectDir, f.opts)).rejects.toThrow();
    expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
  },
);

it("counts a project hardlink as zero recoverable bytes when the acervo link remains", async () => {
  const f = await fixture();
  const poolPath = join(f.root, "pool", f.sha);
  await mkdir(join(f.root, "pool"), { recursive: true });
  await link(f.sourcePath, poolPath);

  const plan = await planProjectCleanup(f.projectDir, f.opts);
  expect(plan.recoverableBytes).toBe(0);
  expect(plan.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: f.sourcePath, recoverableBytes: 0 }),
  ]));
  expect(plan.preserved).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: poolPath, reason: expect.stringMatching(/acervo/i) }),
  ]));

  await confirm(plan.planId, f.projectDir, f.opts);
  expect(await readFile(poolPath, "utf8")).toBe("source media");
  await expect(withResourceWork(f.projectDir, "render", [{ sha256: f.sha }], async () => undefined))
    .rejects.toBeInstanceOf(CleanedResourceError);
});

it("never follows or removes a symlink that escapes the project directory", async () => {
  const f = await fixture();
  const outsidePath = join(f.root, "outside-secret.txt");
  const linkPath = join(f.projectDir, "imports", "outside.txt");
  await writeFile(outsidePath, "outside data");
  await (await import("node:fs/promises")).symlink(outsidePath, linkPath);

  const plan = await planProjectCleanup(f.projectDir, f.opts);
  await confirm(plan.planId, f.projectDir, f.opts);
  expect(await readFile(outsidePath, "utf8")).toBe("outside data");
});

it("rebuilds a durable release after the ledger index is lost", async () => {
  const f = await fixture();
  const plan = await planProjectCleanup(f.projectDir, f.opts);
  await confirm(plan.planId, f.projectDir, f.opts);
  await rm(join(f.root, ".decupa", "references.json"));

  const rebooted = await initializeResourceLedger({ root: f.root, projectsRoot: f.projectsRoot, now: () => 31 * 86_400_000, env: {} });
  expect(await rebooted.references(mediaKey(f.sha))).toHaveLength(0);
});

it("recovers an interrupted multi-item cleanup idempotently and preserves its references", async () => {
  const f = await fixture();
  const journalDir = join(f.projectDir, ".decupa", "metrics");
  await mkdir(journalDir, { recursive: true });
  await writeFile(join(journalDir, "one.jsonl"), "first journal");
  await writeFile(join(journalDir, "two.jsonl"), "second journal");
  const plan = await planProjectCleanup(f.projectDir, f.opts);

  // Force a failure after one item has moved so reconciliation must inspect progress on disk.
  renameFailure.calls = 0;
  renameFailure.rollbackCalls = 0;
  renameFailure.failAt = 2;
  renameFailure.rollbackFailAt = 1;
  await expect(confirm(plan.planId, f.projectDir, f.opts)).rejects.toThrow(/interrupted/i);
  expect(renameFailure.calls).toBe(2);
  // A failed in-process rollback must leave a durable transaction for boot recovery.
  expect.soft(renameFailure.rollbackCalls).toBe(1);
  await expect(f.ledger.references(mediaKey(f.sha))).rejects.toBeInstanceOf(CleanedResourceError);
  await expect(withResourceWork(f.projectDir, "render", [{ sha256: f.sha }], async () => undefined))
    .rejects.toBeInstanceOf(CleanedResourceError);
  const otherProjectsRoot = join(f.root, "other-projects");
  const otherDir = join(otherProjectsRoot, "other");
  await mkdir(otherDir, { recursive: true });
  const otherSha = "b".repeat(64);
  await writeFile(join(otherDir, "project.json"), JSON.stringify({
    revision: 1, assembly: { sources: [{ sha256: otherSha, path: join(otherDir, "source.mp4") }] },
  }));
  const otherLedger = await initializeResourceLedger({ root: f.root, projectsRoot: otherProjectsRoot, now: () => 30 * 86_400_000, env: {} });
  await expect(otherLedger.references(mediaKey(otherSha))).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: `project:${otherDir}`, kind: "project" }),
  ]));
  await expect(withResourceWork(otherDir, "render", [{ sha256: otherSha }], async () => "rendered"))
    .resolves.toBe("rendered");
  renameFailure.failAt = 0; renameFailure.rollbackFailAt = 0;

  await Promise.all([reconcileProjectCleanups(f.ledger), reconcileProjectCleanups(f.ledger)]);
  await reconcileProjectCleanups(f.ledger);
  expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
  expect(await readFile(join(journalDir, "one.jsonl"), "utf8")).toBe("first journal");
  expect(await readFile(join(journalDir, "two.jsonl"), "utf8")).toBe("second journal");
  expect(await f.ledger.references(mediaKey(f.sha))).toHaveLength(1);
});

it("continues boot reconciliation past an unrecoverable staging transaction", async () => {
  const f = await fixture();
  const transactionDir = join(f.root, ".decupa", "cleanup-transactions");
  const blockedId = "10000000-0000-4000-8000-000000000001";
  const recoveredId = "20000000-0000-4000-8000-000000000002";
  const blockedTrash = join(f.projectDir, ".decupa", "cleanup-trash", blockedId, "0");

  async function writeStaging(projectDir: string, id: string, original: string, trash: string, resources: string[]) {
    await mkdir(join(projectDir, ".decupa", "cleanup-trash", id), { recursive: true });
    await mkdir(transactionDir, { recursive: true });
    await writeFile(trash, `staged:${id}`);
    const record = {
      version: 1, id, projectDir, state: "staging", resources,
      items: [{ path: original, kind: "original", bytes: 10, recoverableBytes: 0, identity: "" }],
    };
    const file = join(transactionDir, `${createHash("sha256").update(projectDir).digest("hex")}.json`);
    await writeFile(file, JSON.stringify(record));
    return file;
  }

  // Destination occupancy makes this transaction impossible to restore.
  const blockedTx = await writeStaging(f.projectDir, blockedId, f.sourcePath, blockedTrash, [mediaKey(f.sha)]);
  // The second project is recoverable and must still be processed after the first failure.
  const recoveredDir = join(f.projectsRoot, "two");
  const recoveredPath = join(recoveredDir, "imports", "source.mp4");
  const recoveredTrash = join(recoveredDir, ".decupa", "cleanup-trash", recoveredId, "0");
  await mkdir(join(recoveredDir, "imports"), { recursive: true });
  await writeFile(join(recoveredDir, "project.json"), JSON.stringify({ revision: 1, assembly: { sources: [] } }));
  const recoveredTx = await writeStaging(recoveredDir, recoveredId, recoveredPath, recoveredTrash, [mediaKey("a".repeat(64))]);

  await expect(reconcileProjectCleanups(f.ledger)).rejects.toBeInstanceOf(CleanedResourceError);
  expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
  await expect(readFile(blockedTx)).resolves.toBeTruthy();
  await expect(readFile(recoveredPath, "utf8")).resolves.toBe(`staged:${recoveredId}`);
  await expect(readFile(recoveredTrash)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(recoveredTx)).rejects.toMatchObject({ code: "ENOENT" });

  const unrelatedDir = join(f.projectsRoot, "unrelated");
  await mkdir(unrelatedDir, { recursive: true });
  await expect(withResourceWork(unrelatedDir, "render", [{ sha256: "b".repeat(64) }], async () => "ok"))
    .resolves.toBe("ok");
});

it("treats durable release receipts as authoritative over a stale ledger snapshot", async () => {
  const f = await fixture();
  const key = mediaKey(f.sha);
  await f.ledger.withCleanupLock(async release => release(f.projectDir, [key]));
  const releaseReceipt = join(f.root, ".decupa", "resource-releases", `${createHash("sha256").update(f.projectDir).digest("hex")}.json`);
  await expect(readFile(releaseReceipt, "utf8")).resolves.toContain(key);
  // Simulate a crash after deleting the receipt and before rewriting references.json.
  await rm(releaseReceipt);

  await f.ledger.reconcile();
  await expect(f.ledger.references(key)).resolves.toContainEqual(expect.objectContaining({
    id: `project:${f.projectDir}`, kind: "project",
  }));
  await expect(withResourceWork(f.projectDir, "render", [{ sha256: f.sha }], async () => "rendered"))
    .resolves.toBe("rendered");
});

it("rolls a failed quarantine back inside confirmation and releases other project work", async () => {
  const f = await fixture();
  const journalDir = join(f.projectDir, ".decupa", "metrics");
  await mkdir(journalDir, { recursive: true });
  await writeFile(join(journalDir, "journal.jsonl"), "journal data");
  const plan = await planProjectCleanup(f.projectDir, f.opts);

  renameFailure.calls = 0;
  renameFailure.rollbackCalls = 0;
  renameFailure.failAt = 2;
  await expect(confirm(plan.planId, f.projectDir, f.opts)).rejects.toThrow(/interrupted/i);
  renameFailure.failAt = 0;

  expect(renameFailure.calls).toBe(2);
  expect(renameFailure.rollbackCalls).toBe(1);
  expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
  expect(await readFile(join(journalDir, "journal.jsonl"), "utf8")).toBe("journal data");
  const txPath = join(f.root, ".decupa", "cleanup-transactions", `${createHash("sha256").update(f.projectDir).digest("hex")}.json`);
  await expect(readFile(txPath)).rejects.toMatchObject({ code: "ENOENT" });

  const otherDir = join(f.projectsRoot, "other");
  await mkdir(otherDir, { recursive: true });
  const other = blankProject("other");
  await createProject(otherDir, other);
  await withResourceWork(otherDir, "render", [{ sha256: "b".repeat(64) }], async () => undefined);
  await saveProject(otherDir, 0, current => ({ ...current, input: { ...current.input, text: "updated metadata" } }));
});

it("releases the last project reference only when the remaining eligible project removes its own alias", async () => {
  const f = await fixture();
  const secondDir = join(f.projectsRoot, "two");
  const secondSource = join(secondDir, "imports", "source.mp4");
  await mkdir(join(secondDir, "imports"), { recursive: true });
  await writeFile(secondSource, "second alias");
  await writeFile(join(secondDir, "project.json"), JSON.stringify({
    revision: 1,
    finalApprovedRevision: 1,
    lifecycle: { state: "entregue", revision: 1, enteredAt: { entregue: 30 * 86_400_000 - 8 * 86_400_000 } },
    assembly: { sources: [{ sha256: f.sha, path: secondSource }] },
  }));
  await f.ledger.reconcile();

  const firstPlan = await planProjectCleanup(f.projectDir, f.opts);
  expect(firstPlan.items.map(item => item.path)).not.toContain(f.sourcePath);
  expect(firstPlan.preserved).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: f.sourcePath, reason: expect.stringMatching(/referenciada/i) }),
  ]));
  await confirm(firstPlan.planId, f.projectDir, f.opts);
  expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
  expect(await f.ledger.references(mediaKey(f.sha))).toEqual([
    expect.objectContaining({ id: `project:${secondDir}`, kind: "project" }),
  ]);

  const secondPlan = await planProjectCleanup(secondDir, f.opts);
  expect(secondPlan.items.map(item => item.path)).toContain(secondSource);
  await confirm(secondPlan.planId, secondDir, f.opts);
  await expect(readFile(secondSource)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.ledger.references(mediaKey(f.sha))).toHaveLength(0);
});

it("prunes a missing project's release and lets a recreated project reuse the acervo media", async () => {
  const f = await fixture();
  const plan = await planProjectCleanup(f.projectDir, f.opts);
  await confirm(plan.planId, f.projectDir, f.opts);
  const releaseReceipt = join(f.root, ".decupa", "resource-releases", `${createHash("sha256").update(f.projectDir).digest("hex")}.json`);
  await rm(f.projectDir, { recursive: true, force: true });
  await f.ledger.reconcile();
  await expect(readFile(releaseReceipt)).rejects.toMatchObject({ code: "ENOENT" });

  const poolPath = join(f.root, "pool", f.sha);
  await mkdir(join(f.root, "pool"), { recursive: true });
  await writeFile(poolPath, "preserved pool media");
  await mkdir(f.projectDir, { recursive: true });
  const recreated = blankProject("one");
  const revision = recreated.revision + 1;
  recreated.revision = revision;
  recreated.assembly = {
    ...recreated.assembly,
    revision,
    sources: [{ ...fixtureAssembly().sources[0]!, id: "camera", sha256: f.sha, path: poolPath }],
  };
  await createProject(f.projectDir, recreated);
  expect(await f.ledger.references(mediaKey(f.sha))).toContainEqual(expect.objectContaining({
    id: `project:${f.projectDir}`, kind: "project",
  }));
  await expect(withResourceWork(f.projectDir, "render", [{ sha256: f.sha }], async () => "rendered"))
    .resolves.toBe("rendered");
});

it("does not turn a completed cleanup into an error when a reservation descriptor is unreadable", async () => {
  const f = await fixture();
  const plan = await planProjectCleanup(f.projectDir, f.opts);
  const reservations = join(f.root, ".reservations");
  await mkdir(reservations, { recursive: true });
  await writeFile(join(reservations, "unreadable.json"), "{not valid json");

  await expect(confirm(plan.planId, f.projectDir, f.opts)).resolves.toMatchObject({ planId: plan.planId });
  await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("counts a hardlinked export alias once and removes both source aliases on confirmation", async () => {
  const f = await fixture();
  const exportDir = join(f.projectDir, "exports", "1");
  await mkdir(exportDir, { recursive: true });
  await writeFile(join(exportDir, "manifest.json"), JSON.stringify({ sources: { camera: f.sha } }));
  const exportAlias = join(exportDir, "alias.mp4");
  await link(f.sourcePath, exportAlias);
  await writeFile(join(exportDir, "timeline.otio"), JSON.stringify({
    OTIO_SCHEMA: "Timeline.1",
    tracks: { children: [{
      OTIO_SCHEMA: "Clip.2",
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: "alias.mp4",
        metadata: { decupa: { sourceId: "camera" } },
      },
    }] },
  }));

  const plan = await planProjectCleanup(f.projectDir, f.opts);
  expect(plan.items.map(item => item.path)).toEqual(expect.arrayContaining([f.sourcePath, exportAlias]));
  expect(plan.recoverableBytes).toBe(Buffer.byteLength("source media"));
  expect(plan.items.reduce((sum, item) => sum + item.recoverableBytes, 0)).toBe(plan.recoverableBytes);
  await confirm(plan.planId, f.projectDir, f.opts);
  await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(exportAlias)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an export alias hardlinked to the pool and reports recoverable bytes per item", async () => {
  const f = await fixture();
  const poolPath = join(f.root, "pool", f.sha);
  const exportDir = join(f.projectDir, "exports", "1");
  const exportAlias = join(exportDir, "alias.mp4");
  await mkdir(join(f.root, "pool"), { recursive: true });
  await mkdir(exportDir, { recursive: true });
  await writeFile(poolPath, "acervo media");
  await link(poolPath, exportAlias);
  await writeFile(join(exportDir, "manifest.json"), JSON.stringify({ sources: { camera: f.sha } }));
  await writeFile(join(exportDir, "timeline.otio"), JSON.stringify({
    OTIO_SCHEMA: "Timeline.1",
    tracks: { children: [{ OTIO_SCHEMA: "Clip.2", media_reference: {
      OTIO_SCHEMA: "ExternalReference.1", target_url: "alias.mp4", metadata: { decupa: { sourceId: "camera" } },
    } }] },
  }));

  const plan = await planProjectCleanup(f.projectDir, f.opts);
  expect(plan.items.map(item => item.path)).not.toContain(exportAlias);
  expect(plan.preserved).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: exportAlias, reason: expect.stringMatching(/acervo|hardlink/i) }),
  ]));
  expect(plan.items.reduce((sum, item) => sum + item.recoverableBytes, 0)).toBe(plan.recoverableBytes);
  await confirm(plan.planId, f.projectDir, f.opts);
  await expect(readFile(exportAlias, "utf8")).resolves.toBe("acervo media");
  await expect(readFile(poolPath, "utf8")).resolves.toBe("acervo media");
});

it("physically prunes dead work and reservation descriptors only after confirmation", async () => {
  const f = await fixture();
  const ownerId = "in-progress:dead-descriptor:test";
  const deadPid = 2_147_483_647;
  await f.ledger.register({ id: ownerId, kind: "in-progress", projectDir: f.projectDir, pid: deadPid }, [mediaKey(f.sha)]);
  const ownerPath = join(f.root, ".decupa", "reference-owners", `${createHash("sha256").update(ownerId).digest("hex")}.json`);
  const reservationPath = join(f.root, ".reservations", "dead-owner.json");
  await mkdir(join(f.root, ".reservations"), { recursive: true });
  await writeFile(reservationPath, JSON.stringify({ pid: deadPid }));

  const plan = await planProjectCleanup(f.projectDir, f.opts);
  expect(await readFile(ownerPath, "utf8")).toContain(ownerId);
  expect(await readFile(reservationPath, "utf8")).toContain(String(deadPid));
  await confirm(plan.planId, f.projectDir, f.opts);
  await expect(readFile(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("blocks publishing a removed original in a new project but permits the preserved pool path", async () => {
  const blocked = await publicationFixture();
  let rejected = false;
  try {
    await saveProject(blocked.projectB, 0, addSourceAt(blocked.sourcePath));
  } catch {
    rejected = true;
  }
  expect.soft(rejected, "publishing a released project-local source must be rejected").toBe(true);
  expect.soft((await loadProject(blocked.projectB)).assembly.sources, "the rejected source must not be committed").toHaveLength(0);

  const allowed = await publicationFixture();
  await expect(saveProject(allowed.projectB, 0, addSourceAt(allowed.poolPath))).resolves.toBeUndefined();
  await expect(loadProject(allowed.projectB)).resolves.toMatchObject({
    assembly: { sources: [expect.objectContaining({ path: allowed.poolPath, sha256: allowed.sha })] },
  });
});

it("replans after a reference registers while confirmation waits for the publication lock", async () => {
  const f = await fixture();
  const plan = await planProjectCleanup(f.projectDir, f.opts);
  let enterLock!: () => void;
  let releaseLock!: () => void;
  const lockEntered = new Promise<void>(resolve => { enterLock = resolve; });
  const hold = new Promise<void>(resolve => { releaseLock = resolve; });
  const originalWithPublicationLock = f.ledger.withPublicationLock.bind(f.ledger);
  const heldPublication = originalWithPublicationLock(async () => {
    enterLock();
    await hold;
  });
  await lockEntered;

  let confirmationWaiting!: () => void;
  const waitingForPublication = new Promise<void>(resolve => { confirmationWaiting = resolve; });
  f.ledger.withPublicationLock = async <T>(work: () => Promise<T>): Promise<T> => {
    confirmationWaiting();
    return originalWithPublicationLock(work);
  };
  const pendingConfirmation = confirm(plan.planId, f.projectDir, f.opts);
  await waitingForPublication;

  await f.ledger.register({
    id: "package:registered-while-cleanup-waits",
    kind: "package",
    projectDir: join(f.projectsRoot, "external"),
  }, [mediaKey(f.sha)]);
  releaseLock();

  await expect(pendingConfirmation).rejects.toThrow(/plano mudou|plano.*revise/i);
  await heldPublication;
  expect(await readFile(f.sourcePath, "utf8")).toBe("source media");
  expect(await f.ledger.references(mediaKey(f.sha))).toContainEqual(expect.objectContaining({
    id: "package:registered-while-cleanup-waits", kind: "package",
  }));
});
