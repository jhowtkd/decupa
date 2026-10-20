import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const publicationsLockDenied = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      if (publicationsLockDenied.enabled && String(args[0]).endsWith("/publications.lock")) {
        throw Object.assign(new Error("publications lock denied"), { code: "EACCES" });
      }
      return actual.open(...args);
    }),
  };
});

import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject, loadProject, saveProject } from "./assembly/store.ts";
import { initializeResourceLedger } from "./resource-ledger.ts";

const roots: string[] = [];
afterEach(async () => {
  publicationsLockDenied.enabled = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("allows metadata-only project publication when publications.lock returns EACCES", async () => {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-cleanup-publication-lock-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "metadata-only");
  await mkdir(projectDir, { recursive: true });
  await initializeResourceLedger({ root, projectsRoot, env: {} });
  await createProject(projectDir, blankProject("metadata-only"));

  publicationsLockDenied.enabled = true;
  await expect(saveProject(projectDir, 0, current => ({
    ...current,
    revision: current.revision + 1,
    assembly: { ...current.assembly, revision: current.revision + 1 },
    input: { ...current.input, text: "updated metadata" },
  }))).resolves.toBeUndefined();
  await expect(loadProject(projectDir)).resolves.toMatchObject({ revision: 1, input: { text: "updated metadata" } });
});

it("rejects a newly published source when publications.lock returns EACCES", async () => {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-cleanup-new-source-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "new-source");
  const sourcePath = join(root, "outside", "source.mp4");
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(sourcePath, "source");
  await initializeResourceLedger({ root, projectsRoot, env: {} });
  await createProject(projectDir, blankProject("new-source"));

  publicationsLockDenied.enabled = true;
  await expect(saveProject(projectDir, 0, current => {
    const revision = current.revision + 1;
    const source = { ...fixtureAssembly().sources[0]!, id: "camera", sha256: "a".repeat(64), path: sourcePath };
    return { ...current, revision, assembly: { ...current.assembly, revision, sources: [source] } };
  })).rejects.toMatchObject({ code: "EACCES" });
  await expect(loadProject(projectDir)).resolves.toMatchObject({ assembly: { sources: [] } });
});

it("allows metadata save in another project while a cleanup transaction is pending elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-cleanup-pending-publication-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectA = join(projectsRoot, "cleanup-a");
  const projectB = join(projectsRoot, "metadata-b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await initializeResourceLedger({ root, projectsRoot, env: {} });
  await createProject(projectA, blankProject("cleanup-a"));
  await createProject(projectB, blankProject("metadata-b"));
  const txPath = join(root, ".decupa", "cleanup-transactions", `${createHash("sha256").update(projectA).digest("hex")}.json`);
  await mkdir(join(root, ".decupa", "cleanup-transactions"), { recursive: true });
  await writeFile(txPath, JSON.stringify({
    version: 1, id: "00000000-0000-4000-8000-000000000001", projectDir: projectA, state: "staging", resources: [], items: [],
  }));

  await expect(saveProject(projectB, 0, current => ({
    ...current,
    revision: current.revision + 1,
    assembly: { ...current.assembly, revision: current.revision + 1 },
    input: { ...current.input, text: "metadata while another scope is recovering" },
  }))).resolves.toBeUndefined();
  await expect(loadProject(projectB)).resolves.toMatchObject({ revision: 1, input: { text: "metadata while another scope is recovering" } });
});
