import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { referenceForAssembly } from "../../../../tests/fixtures/timeline-reference.ts";
import { startApp } from "./server.ts";
import { confirmProjectCleanup, planProjectCleanup } from "./project-cleanup.ts";
import { initializeResourceLedger, mediaKey } from "./resource-ledger.ts";
import { confirmImportVerification, exportApproved } from "./assembly/export.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { blankProject } from "./assembly/routes.ts";
import { createProject, loadProject } from "./assembly/store.ts";
import type { Project } from "./assembly/types.ts";

const roots: string[] = [];
const apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
});

const verifiedAt = Date.parse("2026-01-10T12:00:00.000Z");
const eligibleAt = verifiedAt + 8 * 86_400_000;

async function projectFixture(dir: string, id: string, assembly: Project["assembly"]): Promise<Project> {
  const project = blankProject(id);
  project.revision = 1;
  project.assembly = assembly;
  project.previewRevision = 1;
  project.finalApprovedRevision = 1;
  await mkdir(join(dir, "rev-1"), { recursive: true });
  const reference = join(dir, "rev-1", "reference.mp4");
  await copyFile(await referenceForAssembly(assembly), reference);
  project.previewArtifact = {
    revision: 1,
    relativePath: relative(dir, reference),
    sha256: await hashFile(reference),
    assemblySha256: createHash("sha256").update(JSON.stringify(assembly)).digest("hex"),
  };
  await createProject(dir, project);
  return project;
}

it("integra pacote, ledger e limpeza: aviso, reconstrução, mídia compartilhada/acervo e download após remoção", async () => {
  const root = await mkdtemp(join(tmpdir(), "f4-onda2-pacote-limpeza-")); roots.push(root);
  const projectsRoot = join(root, "projects");
  const projectA = join(projectsRoot, "a");
  const projectB = join(projectsRoot, "b");
  const ownPath = join(projectA, "imports", "original-proprio.mp4");
  const sharedPath = join(projectA, "imports", "original-compartilhado.mov");
  const poolPath = join(root, "pool", "original-acervo.mov");
  await Promise.all([
    mkdir(join(projectA, "imports"), { recursive: true }),
    mkdir(join(projectB, "imports"), { recursive: true }),
    mkdir(join(root, "pool"), { recursive: true }),
  ]);
  await copyFile(join(FIXTURES, "clip.mp4"), ownPath);
  await copyFile(join(FIXTURES, "tc-1h-25.mov"), sharedPath);
  await copyFile(join(FIXTURES, "vertical-360x640.mov"), poolPath);

  vi.setSystemTime(verifiedAt);
  const ledger = await initializeResourceLedger({ root, projectsRoot, now: () => Date.now(), env: {} });
  const assembly = fixtureAssembly();
  const own = assembly.sources[0]!;
  own.path = ownPath; own.name = "original-proprio.mp4"; own.sha256 = await hashFile(ownPath);
  const shared = assembly.sources[1]!;
  shared.path = sharedPath; shared.name = "original-compartilhado.mov"; shared.sha256 = await hashFile(sharedPath);
  const poolSource = { ...shared, id: "c", path: poolPath, name: "original-acervo.mov", sha256: await hashFile(poolPath) };
  assembly.sources.push(poolSource);
  // A linha de apoio do OTIO usa a fonte no acervo; a fonte compartilhada
  // continua referenciada pelo Projeto A, mas não é necessária no pacote.
  assembly.tracks.find(track => track.name === "V2")!.clips[0]!.sourceId = poolSource.id;
  assembly.tracks.find(track => track.kind === "Audio")!.clips[0]!.sourceId = own.id;

  const pA = await projectFixture(projectA, "a", assembly);
  const assemblyB = fixtureAssembly();
  assemblyB.sources = [{ ...assemblyB.sources[0]!, id: "a", path: sharedPath, name: "original-compartilhado.mov", sha256: shared.sha256 }];
  assemblyB.tracks = assemblyB.tracks.map(track => ({
    ...track,
    clips: track.clips.filter(clip => clip.sourceId === "a").map(clip => ({ ...clip, sourceId: "a" })),
  })).filter(track => track.clips.length > 0);
  await projectFixture(projectB, "b", assemblyB);

  const exportDir = await exportApproved(pA, projectA);
  await confirmImportVerification(pA, projectA);
  expect(JSON.parse(await readFile(join(exportDir, "verificacao.json"), "utf8")).status).toBe("confirmada");
  expect((await ledger.references(mediaKey(own.sha256))).some(owner => owner.kind === "package" && owner.projectDir === projectA)).toBe(true);

  vi.setSystemTime(eligibleAt);
  const options = { ledger, now: () => eligibleAt, env: {} };
  const firstPlan = await planProjectCleanup(projectA, options);
  expect(firstPlan.eligible).toBe(true);
  expect(firstPlan.items.some(item => item.path === ownPath && item.kind === "original")).toBe(true);
  expect(firstPlan.warning).toMatch(/pacotes.*offline/i);
  expect(firstPlan.preserved.some(item => item.path === poolPath && item.reason === "preservado pelo acervo")).toBe(true);
  expect(firstPlan.items.some(item => item.path === sharedPath)).toBe(false);
  expect(firstPlan.preserved.some(item => item.path === sharedPath && /outro Projeto/.test(item.reason))).toBe(true);

  await expect(confirmProjectCleanup(projectA, { planId: firstPlan.planId, confirmed: false, acknowledgeOffline: true }, options)).rejects.toThrow(/confirmação explícita/i);
  await expect(confirmProjectCleanup(projectA, { planId: firstPlan.planId, confirmed: true }, options)).rejects.toThrow(/aviso.*offline/i);
  await expect(readFile(ownPath, "utf8")).resolves.toBeTruthy();
  await expect(readFile(poolPath, "utf8")).resolves.toBeTruthy();

  // Simula perda do índice derivado; reconcile reconstrói os owners do
  // package-manifest.json e deve preservar a identidade do plano.
  await rm(join(root, ".decupa", "references.json"), { force: true });
  await ledger.reconcile();
  const rebuiltOwners = await ledger.references(mediaKey(own.sha256));
  expect(rebuiltOwners.some(owner => owner.id === `package:${resolve(projectA)}:1` && owner.kind === "package")).toBe(true);
  const rebuiltPlan = await planProjectCleanup(projectA, options);
  expect(rebuiltPlan.planId).toBe(firstPlan.planId);
  expect(rebuiltPlan.items).toEqual(firstPlan.items);
  expect(rebuiltPlan.warning).toBe(firstPlan.warning);

  const app = await startApp({ projectDir: projectA, port: 0, env: { DECUPA_RESOLVE: "0" } });
  apps.push(app);
  await confirmProjectCleanup(projectA, { planId: rebuiltPlan.planId, confirmed: true, acknowledgeOffline: true }, options);
  await expect(readFile(ownPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(sharedPath, "utf8")).resolves.toBeTruthy();
  await expect(readFile(poolPath, "utf8")).resolves.toBeTruthy();

  const packageResponse = await fetch(`http://127.0.0.1:${app.port}/project/output/1/package`);
  const body = await packageResponse.text();
  // Comportamento observado: o endpoint detecta a fonte ausente e retorna
  // erro controlado pedindo nova exportação; não inicia stream truncado.
  expect(packageResponse.status).toBe(409);
  expect(body).toMatch(/exporte novamente/i);
  const projectAfter = await loadProject(projectA);
  expect(projectAfter.revision).toBe(1);
});
