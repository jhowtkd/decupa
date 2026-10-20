import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "decupa-ledger-additional-"));
  roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "one");
  await mkdir(projectDir, { recursive: true });
  const sha = "b".repeat(64);
  await writeFile(join(projectDir, "project.json"), JSON.stringify({
    assembly: { sources: [{ sha256: sha, path: "/missing/source.mp4", included: false }] },
  }));
  return { root, projectsRoot, projectDir, sha };
}

it("reconciliation restores project, excluded-source, and per-revision export owners from disk", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { root, projectsRoot, projectDir, sha } = await fixture();
  for (const revision of ["2", "5"]) {
    const exportDir = join(projectDir, "exports", revision);
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "manifest.json"), JSON.stringify({ sources: { camera: sha } }));
  }

  const first = await initializeResourceLedger({ root, projectsRoot });
  expect((await first.references(mediaKey(sha))).map(owner => owner.id).sort()).toEqual([
    `export:${projectDir}:2`, `export:${projectDir}:5`, `project:${projectDir}`,
  ]);
  await rm(join(root, ".decupa", "references.json"));

  const rebooted = await initializeResourceLedger({ root, projectsRoot });
  expect((await rebooted.references(mediaKey(sha))).map(owner => owner.id).sort()).toEqual([
    `export:${projectDir}:2`, `export:${projectDir}:5`, `project:${projectDir}`,
  ]);
});

it("persists explicitly registered package owners when rebuilding a missing index", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { root, projectsRoot, sha } = await fixture();
  const ledger = await initializeResourceLedger({ root, projectsRoot });
  await ledger.register({ id: "package:bundle-42", kind: "package", projectDir: join(projectsRoot, "one") }, [mediaKey(sha)]);
  await rm(join(root, ".decupa", "references.json"));

  const rebooted = await initializeResourceLedger({ root, projectsRoot });
  expect(await rebooted.references(mediaKey(sha))).toContainEqual({
    id: "package:bundle-42", kind: "package", projectDir: join(projectsRoot, "one"),
  });
});

it("drops owners from another process session but keeps work registered in the current session", async () => {
  const { initializeResourceLedger, mediaKey, withResourceWork } = await import("./resource-ledger.ts");
  const { root, projectsRoot, projectDir, sha } = await fixture();
  const ledger = await initializeResourceLedger({ root, projectsRoot });
  await ledger.register({ id: "work:stale-session", kind: "in-progress", projectDir, pid: process.pid, sessionId: "old-session" }, [mediaKey(sha)]);
  await ledger.reconcile();

  const owners = await ledger.references(mediaKey(sha));
  expect(owners).toContainEqual(expect.objectContaining({ id: `project:${projectDir}`, kind: "project" }));
  expect(owners).toHaveLength(1);
  expect(JSON.parse(await readFile(join(root, ".decupa", "references.json"), "utf8")).entries)
    .not.toContainEqual(expect.objectContaining({ owner: expect.objectContaining({ id: "work:stale-session" }) }));

  await withResourceWork(projectDir, "render", [{ sha256: sha }], async () => {
    await ledger.reconcile();
    const active = await ledger.references(mediaKey(sha));
    expect(active.filter(owner => owner.kind === "in-progress")).toHaveLength(1);
    expect(await ledger.hasWork(projectDir)).toBe(true);
  });
  expect(await ledger.hasWork(projectDir)).toBe(false);
});

it("rebuilds a delivery owner from real per-revision request manifests", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { root, projectsRoot, projectDir } = await fixture();
  const deliveredSha = "c".repeat(64);
  const revisionDir = join(projectDir, "deliveries", "4");
  await mkdir(revisionDir, { recursive: true });
  await writeFile(join(revisionDir, "request-550e8400-e29b-41d4-a716-446655440000.json"), JSON.stringify({
    operationId: "550e8400-e29b-41d4-a716-446655440000",
    revision: 4,
    assembly: { sources: [{ id: "camera", sha256: deliveredSha }] },
  }));

  const ledger = await initializeResourceLedger({ root, projectsRoot });
  expect(await ledger.references(mediaKey(deliveredSha))).toEqual([
    expect.objectContaining({ id: `delivery:${projectDir}:4`, kind: "delivery", projectDir }),
  ]);
});

it("counts hardlinked pool and export files once by inode", async () => {
  const { uniqueFileBytes } = await import("./space.ts");
  const { root } = await fixture();
  const pool = join(root, "pool", "media.mp4");
  const exported = join(root, "exports", "media.mp4");
  await mkdir(join(root, "pool"), { recursive: true });
  await mkdir(join(root, "exports"), { recursive: true });
  await writeFile(pool, "shared media bytes");
  await link(pool, exported);

  expect(await uniqueFileBytes([pool, exported])).toBe(Buffer.byteLength("shared media bytes"));
});
