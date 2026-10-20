import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const importIo = vi.hoisted(() => ({
  forceExdev: false,
  bavail: 10 ** 12,
  reservationRoot: "",
  importsDir: "",
  projectJsonPath: "",
  publishFailure: "none" as "none" | "before" | "after",
  linkCalls: 0,
  copyCalls: 0,
  copiedPaths: [] as string[],
  statfsPaths: [] as string[],
  reservationsDuringCopy: [] as Array<{ pid?: number; claims?: Array<{ path: string; bytes: number; materializedPath?: string }> }>,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      importIo.linkCalls++;
      if (importIo.forceExdev && String(args[1]).startsWith(`${importIo.importsDir}/`)) {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      }
      return actual.link(...args);
    }),
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      const destination = String(args[1]);
      if (importIo.importsDir && destination.startsWith(`${importIo.importsDir}/`)) {
        importIo.copyCalls++;
        importIo.copiedPaths.push(destination);
        const reservationDir = join(importIo.reservationRoot, ".reservations");
        const files = await actual.readdir(reservationDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        importIo.reservationsDuringCopy = await Promise.all(files.filter(file => file.endsWith(".json")).map(async file =>
          JSON.parse(await actual.readFile(join(reservationDir, file), "utf8")) as typeof importIo.reservationsDuringCopy[number],
        ));
      }
      return actual.copyFile(...args);
    }),
    statfs: vi.fn(async (...args: Parameters<typeof actual.statfs>) => {
      const real = await actual.statfs(...args);
      importIo.statfsPaths.push(String(args[0]));
      return { ...real, bavail: importIo.bavail, bsize: 1 };
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === importIo.projectJsonPath && importIo.publishFailure !== "none") {
        if (importIo.publishFailure === "before") throw new Error("project publication failed before commit");
        await actual.rename(...args);
        throw new Error("project publication reported an error after commit");
      }
      return actual.rename(...args);
    }),
  };
});

import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject, loadProject, saveProject } from "./assembly/store.ts";
import { initializeResourceLedger, mediaKey, withResourceWork } from "./resource-ledger.ts";
import { verifySourceIdentity } from "./assembly/media.ts";

const roots: string[] = [];
afterEach(async () => {
  importIo.forceExdev = false;
  importIo.bavail = 10 ** 12;
  importIo.reservationRoot = "";
  importIo.importsDir = "";
  importIo.projectJsonPath = "";
  importIo.publishFailure = "none";
  importIo.linkCalls = 0;
  importIo.copyCalls = 0;
  importIo.copiedPaths = [];
  importIo.statfsPaths = [];
  importIo.reservationsDuringCopy = [];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "f4-t4-source-import-additional-")); roots.push(root);
  const a = join(root, "source-hub");
  const b = join(root, "consumer-hub");
  for (const dir of [join(a, "imports"), join(b, "imports")]) await mkdir(dir, { recursive: true });
  const originalPath = join(a, "imports", "original.mp4");
  await writeFile(originalPath, "original media bytes for a cross-device copy");
  const source = { ...fixtureAssembly().sources[0]!, path: originalPath };
  const original = blankProject("source-project");
  original.revision = 1;
  original.finalApprovedRevision = 1;
  original.assembly = { ...original.assembly, revision: 1, sources: [source] };
  const ledgerA = await initializeResourceLedger({ root: a, projectDir: a, env: {} });
  await createProject(a, original);
  const ledgerB = await initializeResourceLedger({ root: b, projectDir: b, env: {} });
  await createProject(b, blankProject("consumer-project"));

  importIo.reservationRoot = b;
  importIo.importsDir = join(b, "imports");
  importIo.projectJsonPath = join(b, "project.json");
  return { root, a, b, originalPath, source, ledgerA, ledgerB, importsDir: join(b, "imports") };
}

function publishSource(source: Awaited<ReturnType<typeof fixture>>["source"]) {
  return (project: Awaited<ReturnType<typeof loadProject>>) => {
    const revision = project.revision + 1;
    return { ...project, revision, assembly: { ...project.assembly, revision, sources: [source] } };
  };
}

async function reservationFiles(root: string): Promise<string[]> {
  return readdir(join(root, ".reservations")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

it("copies an imported source after EXDEV while its exact space reservation remains active", async () => {
  const f = await fixture();
  importIo.forceExdev = true;
  const sourceBytes = (await stat(f.originalPath)).size;

  await saveProject(f.b, 0, publishSource(f.source));

  expect(importIo.linkCalls).toBeGreaterThan(0);
  expect(importIo.copyCalls).toBe(1);
  expect(importIo.copiedPaths).toHaveLength(1);
  expect(importIo.statfsPaths.length).toBeGreaterThan(0);
  expect(importIo.reservationsDuringCopy).toEqual(expect.arrayContaining([
    expect.objectContaining({
      pid: process.pid,
      claims: expect.arrayContaining([expect.objectContaining({
        path: expect.stringMatching(/consumer-hub\/imports$/),
        bytes: sourceBytes,
      })]),
    }),
  ]));
  const importedPath = (await loadProject(f.b)).assembly.sources[0]?.path;
  expect(importedPath).toBe(importIo.copiedPaths[0]);
  expect(importedPath).toMatch(new RegExp(`^${f.b}/imports/`));
  expect(await readFile(importedPath!, "utf8")).toBe("original media bytes for a cross-device copy");
  expect(await f.ledgerB.references(mediaKey(f.source.sha256))).toContainEqual(expect.objectContaining({
    id: `project:${f.b}`, kind: "project",
  }));
  await expect(withResourceWork(f.b, "render", [f.source], async () => readFile(importedPath!, "utf8")))
    .resolves.toBe("original media bytes for a cross-device copy");
  expect(await reservationFiles(f.b)).toHaveLength(0);
});

it("publishes the copied source sentinels so identity verification keeps its fast path", async () => {
  const f = await fixture(); importIo.forceExdev = true;
  await utimes(f.originalPath, new Date("2020-01-01"), new Date("2020-01-01"));
  const original = await stat(f.originalPath);
  f.source.size = original.size; f.source.mtimeMs = original.mtimeMs;
  await saveProject(f.b, 0, publishSource(f.source));
  const imported = (await loadProject(f.b)).assembly.sources[0]!;
  const copied = await stat(imported.path);
  expect(imported.size).toBe(copied.size);
  expect(imported.mtimeMs).toBe(copied.mtimeMs);
  // O SHA sintético da fixture não é o hash destes bytes: passar prova o caminho rápido.
  await expect(verifySourceIdentity(imported)).resolves.toBeUndefined();
});

it("rejects a source changed during the copy even when its byte count stays the same", async () => {
  const f = await fixture(); importIo.forceExdev = true;
  await utimes(f.originalPath, new Date("2020-01-01"), new Date("2020-01-01"));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(copyFile).mockImplementationOnce(async (source, destination, mode) => {
    await actual.copyFile(source, destination, mode);
    await actual.writeFile(source, Buffer.alloc((await actual.stat(source)).size, 120));
    await actual.utimes(source, new Date("2021-01-01"), new Date("2021-01-01"));
  });
  await expect(saveProject(f.b, 0, publishSource(f.source))).rejects.toThrow(/fonte mudou durante a cópia/);
  expect((await loadProject(f.b)).assembly.sources).toHaveLength(0);
  expect(await readdir(f.importsDir)).toEqual([]);
  expect(await reservationFiles(f.b)).toHaveLength(0);
});

it("fails with 507 before copying or publishing when the consumer volume has no capacity", async () => {
  const f = await fixture();
  importIo.forceExdev = true;
  importIo.bavail = 0;

  await expect(saveProject(f.b, 0, publishSource(f.source))).rejects.toMatchObject({ status: 507 });

  expect(importIo.copyCalls).toBe(0);
  expect(await loadProject(f.b)).toMatchObject({ assembly: { sources: [] } });
  await expect(readdir(f.importsDir)).resolves.toEqual([]);
  expect(await reservationFiles(f.b)).toHaveLength(0);
});

it("removes only newly copied, unreferenced imports and releases the reservation on publication failure", async () => {
  const f = await fixture();
  const preexisting = join(f.b, "imports", "keep.mp4");
  await writeFile(preexisting, "keep existing import");
  importIo.forceExdev = true;
  importIo.publishFailure = "before";

  await expect(saveProject(f.b, 0, publishSource(f.source))).rejects.toThrow(/publication failed before commit/);

  expect(importIo.copyCalls).toBe(1);
  await expect(readFile(preexisting, "utf8")).resolves.toBe("keep existing import");
  await expect(readdir(f.importsDir)).resolves.toEqual(["keep.mp4"]);
  await expect(loadProject(f.b)).resolves.toMatchObject({ assembly: { sources: [] } });
  expect(await f.ledgerB.references(mediaKey(f.source.sha256))).toHaveLength(0);
  expect(await reservationFiles(f.b)).toHaveLength(0);
});

it("keeps a copied import when publication reports an error after project.json committed it", async () => {
  const f = await fixture();
  importIo.forceExdev = true;
  importIo.publishFailure = "after";

  await saveProject(f.b, 0, publishSource(f.source)).catch(() => undefined);

  expect(importIo.copyCalls).toBe(1);
  const importedPath = importIo.copiedPaths[0]!;
  await expect(readFile(importedPath, "utf8")).resolves.toBe("original media bytes for a cross-device copy");
  await expect(loadProject(f.b)).resolves.toMatchObject({ assembly: { sources: [expect.objectContaining({ path: importedPath })] } });
  await f.ledgerB.reconcile();
  expect(await f.ledgerB.references(mediaKey(f.source.sha256))).toContainEqual(expect.objectContaining({
    id: `project:${f.b}`, kind: "project",
  }));
  expect(await reservationFiles(f.b)).toHaveLength(0);
});
