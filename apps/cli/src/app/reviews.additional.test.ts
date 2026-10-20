import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureAssembly } from "./assembly/fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createTempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

it("preserva owners de Hub A, Hub B e projeto standalone após reboots parciais e reconstrução do índice", async () => {
  const { initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const root = await createTempRoot("ledger-review-shared-root-");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  const projectA = join(hubA, "project-a");
  const projectB = join(hubB, "project-b");
  const sha = "d".repeat(64);

  for (const dir of [projectA, projectB]) {
    await mkdir(join(dir, "exports", "1"), { recursive: true });
    await mkdir(join(dir, "deliveries", "1"), { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({ revision: 1, assembly: { sources: [{ sha256: sha }] } }));
    await writeFile(join(dir, "exports", "1", "manifest.json"), JSON.stringify({ sources: { camera: sha } }));
    await writeFile(join(dir, "deliveries", "1", "request-123e4567-e89b-42d3-a456-426614174000.json"), JSON.stringify({ assembly: { sources: [{ sha256: sha }] } }));
  }

  const firstHub = await initializeResourceLedger({ root: join(root, "shared-media"), projectsRoot: hubA });
  const secondHub = await initializeResourceLedger({ root: join(root, "shared-media"), projectsRoot: hubB });
  expect(await secondHub.references(mediaKey(sha))).toHaveLength(6);
  await rm(join(root, "shared-media", ".decupa", "references.json"));

  const standalone = await initializeResourceLedger({ root: join(root, "shared-media"), projectDir: projectA });
  expect(await standalone.references(mediaKey(sha))).toHaveLength(6);
  const rebootedHub = await initializeResourceLedger({ root: join(root, "shared-media"), projectsRoot: hubB });
  expect(await rebootedHub.references(mediaKey(sha))).toHaveLength(6);
  expect(await firstHub.references(mediaKey(sha))).toHaveLength(6);
});

it("falha fechado se a sincronização de ledger falhar depois do commit editorial", async () => {
  const { ResourceLedger, initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { createProject, loadProject, saveProject } = await import("./assembly/store.ts");
  const root = await createTempRoot("ledger-review-commit-");
  const projectDir = join(root, "projects", "editorial");
  await mkdir(projectDir, { recursive: true });
  await initializeResourceLedger({ root, projectsRoot: join(root, "projects") });
  const assembly = fixtureAssembly();
  const project = {
    version: 2 as const, id: "editorial", revision: 1,
    input: { kind: "script" as const, text: "inicial", targetSeconds: 2 },
    assembly, scenes: [], analyses: [], proposal: null,
    previewRevision: null, finalApprovedRevision: null, corrections: [],
    preparation: null, permissions: { model: false, visual: false }, previewArtifact: null,
  };
  await createProject(projectDir, project);
  const sync = vi.spyOn(ResourceLedger.prototype, "syncProject").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

  await expect(saveProject(projectDir, 1, current => ({ ...current, input: { ...current.input, text: "commit durável" } }))).resolves.toBeUndefined();
  expect(sync).toHaveBeenCalledTimes(1);
  await expect(loadProject(projectDir)).resolves.toMatchObject({ revision: 1, input: { text: "commit durável" } });
  await expect((await import("./resource-ledger.ts")).resourceLedgerForProject(projectDir).references(mediaKey(assembly.sources[0]!.sha256)))
    .rejects.toThrow(/incompleto|permission denied|EACCES/i);
  expect(JSON.parse(await readFile(join(projectDir, "project.json"), "utf8")).input.text).toBe("commit durável");
});

it("mantém criação editorial durável quando a primeira sincronização de ledger falha", async () => {
  const { ResourceLedger, initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const { createProject, loadProject } = await import("./assembly/store.ts");
  const root = await createTempRoot("ledger-review-create-");
  const projectDir = join(root, "projects", "new-project");
  await mkdir(projectDir, { recursive: true });
  await initializeResourceLedger({ root, projectsRoot: join(root, "projects") });
  const assembly = fixtureAssembly();
  const project = {
    version: 2 as const, id: "new-project", revision: 1,
    input: { kind: "script" as const, text: "novo", targetSeconds: 2 },
    assembly, scenes: [], analyses: [], proposal: null,
    previewRevision: null, finalApprovedRevision: null, corrections: [],
    preparation: null, permissions: { model: false, visual: false }, previewArtifact: null,
  };
  vi.spyOn(ResourceLedger.prototype, "syncProject").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

  await expect(createProject(projectDir, project)).resolves.toBeUndefined();
  await expect(loadProject(projectDir)).resolves.toMatchObject({ revision: 1, input: { text: "novo" } });
  await expect((await import("./resource-ledger.ts")).resourceLedgerForProject(projectDir).references(mediaKey(assembly.sources[0]!.sha256)))
    .rejects.toThrow(/incompleto|permission denied|EACCES/i);
});

it("degrada com ledger incompleto quando o reconcile de boot falha com EACCES", async () => {
  const { ResourceLedger, initializeResourceLedger, mediaKey } = await import("./resource-ledger.ts");
  const root = await createTempRoot("ledger-review-boot-eacces-");
  vi.spyOn(ResourceLedger.prototype, "reconcile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

  const ledger = await initializeResourceLedger({ root, projectsRoot: join(root, "projects") });
  await expect(ledger.references(mediaKey("e".repeat(64)))).rejects.toThrow(/incompleto|permission denied|EACCES/i);
});

it("recupera lifecycle ativo com confirmação da revisão aprovada usando contexto de initialize", async () => {
  const { initializeResourceLedger } = await import("./resource-ledger.ts");
  const { loadProject } = await import("./assembly/store.ts");
  const root = await createTempRoot("ledger-review-lifecycle-");
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "delivered");
  await mkdir(join(projectDir, "exports", "3"), { recursive: true });
  const project = {
    version: 2, id: "delivered", revision: 3,
    lifecycle: { state: "ativo", enteredAt: { ativo: 1 } },
    input: { kind: "script", text: "tema", targetSeconds: 2 },
    assembly: fixtureAssembly(), scenes: [], analyses: [], proposal: null,
    previewRevision: 3, finalApprovedRevision: 3, corrections: [],
    preparation: null, permissions: { model: false, visual: false }, previewArtifact: null,
  };
  await writeFile(join(projectDir, "project.json"), JSON.stringify(project));
  await writeFile(join(projectDir, "exports", "3", "verificacao.json"), JSON.stringify({
    status: "confirmada", revision: 3, confirmadaEm: "2026-10-10T12:00:00.000Z",
  }));
  await initializeResourceLedger({
    root: join(root, "media-root"), projectsRoot,
    now: () => Date.parse("2026-10-20T12:00:00.000Z"), env: { DECUPA_PROJECT_RETENTION_DAYS: "30" },
  });

  await expect(loadProject(projectDir)).resolves.toMatchObject({
    lifecycle: { state: "entregue", revision: 3, enteredAt: { entregue: Date.parse("2026-10-10T12:00:00.000Z") } },
  });
});

it("mantém projeto ativo aprovado quando a verificação atual está truncada durante load e save", async () => {
  const { initializeResourceLedger } = await import("./resource-ledger.ts");
  const { createProject, loadProject, saveProject } = await import("./assembly/store.ts");
  const root = await createTempRoot("ledger-review-truncated-verification-");
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, "truncated");
  await mkdir(join(projectDir, "exports", "1"), { recursive: true });
  await initializeResourceLedger({ root: join(root, "media-root"), projectsRoot });
  const project = {
    version: 2 as const, id: "truncated", revision: 1,
    lifecycle: { state: "ativo" as const, enteredAt: { ativo: 100 } },
    input: { kind: "script" as const, text: "tema", targetSeconds: 2 },
    assembly: fixtureAssembly(), scenes: [], analyses: [], proposal: null,
    previewRevision: 1, finalApprovedRevision: 1, corrections: [],
    preparation: null, permissions: { model: false, visual: false }, previewArtifact: null,
  };
  await createProject(projectDir, project);
  await writeFile(join(projectDir, "exports", "1", "verificacao.json"), "{\"status\":\"confirmada\"");

  await expect(loadProject(projectDir)).resolves.toMatchObject({ revision: 1, lifecycle: { state: "ativo" } });
  await expect(saveProject(projectDir, 1, current => ({ ...current, input: { ...current.input, text: "continua editável" } })))
    .resolves.toBeUndefined();
  await expect(loadProject(projectDir)).resolves.toMatchObject({
    input: { text: "continua editável" }, lifecycle: { state: "ativo" },
  });
});
