import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { referenceForAssembly } from "../../../../../tests/fixtures/timeline-reference.ts";
import { hashFile } from "@decupa/media";
import { initializeResourceLedger, mediaKey, withResourceWork } from "../resource-ledger.ts";
import { deriveLifecycle, PROJECT_RETENTION_MS } from "../project-lifecycle.ts";
import { exportApproved } from "./export.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createAssemblyRuntime } from "./routes.ts";
import { createProject, loadProject, saveProject } from "./store.ts";
import type { Project } from "./types.ts";

const statfsState = vi.hoisted(() => ({ bavail: 10 ** 12, paths: [] as string[], failLink: false, copiedSources: [] as string[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      if (statfsState.failLink) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      return actual.link(...args);
    }),
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      statfsState.copiedSources.push(String(args[0]));
      return actual.copyFile(...args);
    }),
    statfs: vi.fn(async (...args: Parameters<typeof actual.statfs>) => {
      const real = await actual.statfs(...args);
      statfsState.paths.push(String(args[0]));
      return { ...real, bavail: statfsState.bavail, bsize: 1 };
    }),
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  statfsState.bavail = 10 ** 12;
  statfsState.paths = [];
  statfsState.failLink = false;
  statfsState.copiedSources = [];
  vi.restoreAllMocks();
});

async function projectFixture(create = true) {
  const root = await mkdtemp(join(tmpdir(), "decupa-export-capacity-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = join(root, "projects");
  const dir = join(projectsRoot, "p1");
  await mkdir(dir, { recursive: true });
  await initializeResourceLedger({ root, projectsRoot });

  const assembly = fixtureAssembly();
  for (const source of assembly.sources) {
    source.path = join(dir, source.name);
    await copyFile(join(FIXTURES, "clip.mp4"), source.path);
    source.sha256 = await hashFile(source.path);
  }
  const project: Project = {
    version: 2, id: "p1", revision: 1,
    input: { kind: "brief", text: "tema", targetSeconds: 2 },
    assembly, scenes: [], analyses: [], proposal: null,
    previewRevision: 1, finalApprovedRevision: 1, corrections: [],
    preparation: null, permissions: { model: false, visual: false }, previewArtifact: null,
  };
  const revisionDir = join(dir, "rev-1");
  await mkdir(revisionDir, { recursive: true });
  const reference = join(revisionDir, "reference.mp4");
  await copyFile(await referenceForAssembly(assembly), reference);
  project.previewArtifact = {
    revision: 1,
    assemblySha256: (await import("node:crypto")).createHash("sha256").update(JSON.stringify(assembly)).digest("hex"),
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
  };
  if (create) await createProject(dir, project);
  statfsState.paths = [];
  return { root, projectsRoot, dir, project };
}

it("exportApproved rejects insufficient statfs capacity before publishing output", async () => {
  const { dir, project } = await projectFixture();
  statfsState.bavail = 0;

  await expect(exportApproved(project, dir)).rejects.toThrow(/não há espaço suficiente/);
  expect(statfsState.paths.length).toBeGreaterThan(0);
  await expect(access(join(dir, "exports", "1"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns HTTP 507 with required and available bytes when export capacity is insufficient", async () => {
  const { dir } = await projectFixture();
  const storedProject = await loadProject(dir);
  storedProject.previewArtifact!.assemblySha256 = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(storedProject.assembly)).digest("hex");
  await saveProject(dir, storedProject.revision, storedProject);
  statfsState.bavail = 0;
  const runtime = createAssemblyRuntime(dir, {
    exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    port: () => 0,
  });
  const requestBody = Buffer.from(JSON.stringify({ baseRevision: 1 }));
  const request = {
    method: "POST",
    url: "/project/export",
    headers: {},
    async *[Symbol.asyncIterator]() { yield requestBody; },
  };
  let status = 0;
  let responseBody = "";
  const response = {
    writeHead(code: number) { status = code; },
    end(chunk?: unknown) { if (typeof chunk === "string") responseBody = chunk; },
  };
  try {
    await runtime.handle(request as never, response as never);
    const body = JSON.parse(responseBody) as { error: string };
    expect(status, responseBody).toBe(507);
    expect(body.error).toMatch(/necessários\s+[\d.]+\s+bytes/i);
    expect(body.error).toMatch(/há\s+0\s+bytes\s+livres/i);
  } finally {
    await runtime.close();
  }
});

it("exportApproved includes a pending upload reservation in its shared-volume capacity check", async () => {
  const { root, dir, project } = await projectFixture();
  const uploadId = "00000000-0000-4000-8000-000000000001";
  const uploadDir = join(root, ".tmp", uploadId);
  await mkdir(uploadDir, { recursive: true });
  await writeFile(join(uploadDir, "state.json"), JSON.stringify({ reserva: true, tamanhoTotal: 256 * 1024 * 1024 }));
  // Plenty for this small export alone, but less than the upload's two volume claims.
  statfsState.bavail = 15 * 1024 ** 3 + 64 * 1024 * 1024;

  await expect(exportApproved(project, dir)).rejects.toThrow(/não há espaço suficiente/);
  expect(statfsState.paths).toContain(join(root, ".tmp"));
  // Claims em .tmp e pool estão no mesmo dispositivo e são agregadas numa consulta.
  expect(statfsState.paths).toHaveLength(1);
  await expect(access(join(dir, "exports", "1"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reuses a valid export without a new capacity reservation", async () => {
  const { dir, project } = await projectFixture();
  const first = await exportApproved(project, dir);
  statfsState.paths = [];
  statfsState.bavail = 0;

  await expect(exportApproved(project, dir)).resolves.toBe(first);
  expect(statfsState.paths).toEqual([]);
});

it("allows a large same-device alias when capacity covers only the reference and metadata", async () => {
  const { dir, project } = await projectFixture();
  const source = project.assembly.sources[0]!;
  await writeFile(source.path, Buffer.alloc(16 * 1024 * 1024));
  source.sha256 = await hashFile(source.path);
  const originalName = source.name;
  const aliasName = `alias-${originalName}`;
  source.name = aliasName;
  project.previewArtifact!.assemblySha256 = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex");
  const referenceBytes = (await import("node:fs/promises")).stat(join(dir, project.previewArtifact!.relativePath)).then(info => info.size);
  statfsState.bavail = 15 * 1024 ** 3 + await referenceBytes + 2 * 1024 * 1024;

  const dest = await exportApproved(project, dir);
  const sourceInfo = await (await import("node:fs/promises")).stat(source.path);
  const aliasInfo = await (await import("node:fs/promises")).stat(join(dest, aliasName));
  expect(aliasInfo.ino).toBe(sourceInfo.ino);
  expect(aliasInfo.dev).toBe(sourceInfo.dev);
  expect(statfsState.paths.length).toBeGreaterThan(0);
});

it("readmits a failed hardlink before copying and preserves the previous export when copy capacity is insufficient", async () => {
  const { dir, project } = await projectFixture();
  const initial = await exportApproved(project, dir);
  const previousManifest = await readFile(join(initial, "manifest.json"), "utf8");
  const previousReference = await hashFile(join(initial, "reference.mp4"));
  const source = project.assembly.sources[0]!;
  source.name = `alias-${source.name}`;
  project.previewArtifact!.assemblySha256 = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex");
  statfsState.copiedSources = [];
  statfsState.failLink = true;
  const referenceBytes = await (await import("node:fs/promises")).stat(join(dir, project.previewArtifact!.relativePath)).then(info => info.size);
  // Cabe a referência e os metadados da exportação; o arquivo fonte grande não cabe.
  statfsState.bavail = 15 * 1024 ** 3 + referenceBytes + 1024 * 1024 + 128;

  await expect(exportApproved(project, dir)).rejects.toThrow(/não há espaço suficiente/);
  expect(statfsState.copiedSources).not.toContain(source.path);
  expect(await readFile(join(initial, "manifest.json"), "utf8")).toBe(previousManifest);
  await expect(hashFile(join(initial, "reference.mp4"))).resolves.toBe(previousReference);
});

it("withResourceWork releases its durable work owner when the callback throws", async () => {
  const { root, projectsRoot, dir, project } = await projectFixture();
  const ledger = await initializeResourceLedger({ root, projectsRoot });
  const sha = project.assembly.sources[0]!.sha256;
  await expect(withResourceWork(dir, "render", [{ sha256: sha }], async () => {
    expect((await ledger.references(mediaKey(sha))).filter(owner => owner.kind === "in-progress")).toHaveLength(1);
    throw new Error("render fixture failure");
  })).rejects.toThrow("render fixture failure");
  expect((await ledger.references(mediaKey(sha))).filter(owner => owner.kind === "in-progress")).toHaveLength(0);
});

it("lifecycle leaves pending exports active and gates eligibility on live work and configured retention", async () => {
  const { root, projectsRoot, dir, project } = await projectFixture();
  await mkdir(join(dir, "exports", "1"), { recursive: true });
  await writeFile(join(dir, "exports", "1", "verificacao.json"), JSON.stringify({
    status: "pendente", revision: 1, confirmadaEm: new Date(0).toISOString(),
  }));
  expect((await deriveLifecycle(dir, undefined, { now: () => 20_000_000_000 })).state).toBe("ativo");

  const ledger = await initializeResourceLedger({ root, projectsRoot });
  const enteredAt = 1_000_000;
  const delivered = { state: "entregue" as const, revision: 1, enteredAt: { entregue: enteredAt } };
  const now = enteredAt + 2 * 86_400_000;
  const zeroDayEnv = { DECUPA_PROJECT_RETENTION_DAYS: "0" };
  const mediaSha = project.assembly.sources[0]!.sha256;
  await withResourceWork(dir, "export", [{ sha256: mediaSha }], async () => {
    expect((await deriveLifecycle(dir, delivered, { now: () => now, env: zeroDayEnv })).state).toBe("entregue");
    // Explicit busy protection also overrides an elapsed configured retention.
    expect((await deriveLifecycle(dir, delivered, { now: () => now, busy: true, env: zeroDayEnv })).state).toBe("entregue");
    expect(await ledger.hasWork(dir)).toBe(true);
  });
  expect((await deriveLifecycle(dir, delivered, { now: () => now, env: zeroDayEnv })).state).toBe("elegível");
  expect((await deriveLifecycle(dir, delivered, { now: () => now, env: { DECUPA_PROJECT_RETENTION_DAYS: "3" } })).state).toBe("entregue");
  expect((await deriveLifecycle(dir, delivered, { now: () => enteredAt + PROJECT_RETENTION_MS - 1 })).state).toBe("entregue");
});

it("returns an edited delivery to active and starts retention from confirmation of the new revision", async () => {
  const { dir } = await projectFixture();
  const firstConfirmation = "2024-01-02T03:04:05.000Z";
  await mkdir(join(dir, "exports", "1"), { recursive: true });
  await writeFile(join(dir, "exports", "1", "verificacao.json"), JSON.stringify({
    status: "confirmada", revision: 1, confirmadaEm: firstConfirmation,
  }));
  const first = await deriveLifecycle(dir, undefined, { now: () => Date.parse("2024-01-03T00:00:00.000Z") });
  expect(first).toMatchObject({ state: "entregue", revision: 1, enteredAt: { entregue: Date.parse(firstConfirmation) } });
  await saveProject(dir, 1, current => ({ ...current, lifecycle: first }));

  await saveProject(dir, 1, current => ({ ...current, revision: 2, finalApprovedRevision: 2 }));
  const edited = await loadProject(dir);
  expect(edited.lifecycle).toMatchObject({ state: "ativo", revision: 2 });

  const secondConfirmation = "2024-03-04T05:06:07.000Z";
  await mkdir(join(dir, "exports", "2"), { recursive: true });
  await writeFile(join(dir, "exports", "2", "verificacao.json"), JSON.stringify({
    status: "confirmada", revision: 2, confirmadaEm: secondConfirmation,
  }));
  const reconfirmed = await deriveLifecycle(dir, undefined, { now: () => Date.parse("2024-03-05T00:00:00.000Z") });
  expect(reconfirmed).toMatchObject({ state: "entregue", revision: 2, enteredAt: { entregue: Date.parse(secondConfirmation) } });
  expect(reconfirmed.enteredAt.entregue).toBeGreaterThan(first.enteredAt.entregue!);
  expect((await deriveLifecycle(dir, reconfirmed, { now: () => Date.parse("2024-03-10T00:00:00.000Z") })).state).toBe("entregue");
});

it("does not infer delivery from a confirmed export for an older revision", async () => {
  const { dir } = await projectFixture();
  const projectPath = join(dir, "project.json");
  const stored = JSON.parse(await readFile(projectPath, "utf8"));
  delete stored.lifecycle; // simulate legacy project without persisted lifecycle
  stored.revision = 2;
  stored.finalApprovedRevision = 2;
  await writeFile(projectPath, JSON.stringify(stored));
  await mkdir(join(dir, "exports", "1"), { recursive: true });
  await writeFile(join(dir, "exports", "1", "verificacao.json"), JSON.stringify({
    status: "confirmada", revision: 1, confirmadaEm: "2024-01-02T03:04:05.000Z",
  }));

  expect((await deriveLifecycle(dir, undefined, { now: () => Date.parse("2024-01-03T00:00:00.000Z") })).state).toBe("ativo");
});

it("store saves and reloads lifecycle timestamps across revision updates", async () => {
  const { dir, project } = await projectFixture(false);
  project.lifecycle = { state: "arquivado", enteredAt: { ativo: 100, arquivado: 200 } };
  await createProject(dir, project);
  const loaded = await loadProject(dir);
  expect(loaded.lifecycle).toEqual(project.lifecycle);

  await saveProject(dir, 1, current => ({ ...current, revision: 2 }));
  expect((await loadProject(dir)).lifecycle).toEqual(project.lifecycle);
  expect(JSON.parse(await readFile(join(dir, "project.json"), "utf8")).lifecycle).toEqual(project.lifecycle);
});
