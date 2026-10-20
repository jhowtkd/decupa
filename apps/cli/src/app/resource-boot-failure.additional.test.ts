import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { startApp } from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const sharedMedia = join(root, "shared-media");
  const hubA = join(root, "hub-a");
  const hubB = join(root, "hub-b");
  const projectA = join(hubA, "project-a");
  const projectB = join(hubB, "project-b");
  const shaA = "a".repeat(64);
  const shaB = "b".repeat(64);
  const assembly = fixtureAssembly();
  for (const [dir, id, sha] of [[projectA, "project-a", shaA], [projectB, "project-b", shaB]] as const) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({
      ...blankProject(id),
      assembly: { ...assembly, sources: assembly.sources.map(source => ({ ...source, sha256: sha })) },
    }));
  }
  const boot = (projectsRoot: string, projectDir: string, projectId: string, port = 0) =>
    startApp({ projectsRoot, projectDir, projectId, port, autoStart: false, env: { DECUPA_MEDIA_ROOT: sharedMedia } });
  return { root, sharedMedia, hubA, hubB, projectA, projectB, shaB, boot };
}

async function waitForReferences(projectDir: string, sha: string) {
  const { mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await resourceLedgerForProject(projectDir).references(mediaKey(sha));
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/incompleto/.test(error.message) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

async function assertHubBUsableAfterHubAFailure(failure: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>, prefix: string) {
  const context = await setup(prefix);
  const first = await context.boot(context.hubA, context.projectA, "project-a");
  await waitForReferences(context.projectA, "a".repeat(64));
  await first.close();

  await failure(context);

  const second = await context.boot(context.hubB, context.projectB, "project-b");
  await waitForReferences(context.projectB, context.shaB);
  await second.close();
  const { mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
  const owners = await resourceLedgerForProject(context.projectB).references(mediaKey(context.shaB));
  expect(owners).toContainEqual(expect.objectContaining({
    id: `project:${context.projectB}`, projectDir: context.projectB,
  }));
}

it("falha ao bindar Hub A sem deixar referências de Hub B pending", async () => {
  await assertHubBUsableAfterHubAFailure(async context => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("porta de teste ausente");
    try {
      await expect(context.boot(context.hubA, context.projectA, "project-a", address.port))
        .rejects.toThrow(/EADDRINUSE|address already in use|listen/i);
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  }, "resource-boot-failure-port-");
});

it("recusa caminho inicial fora do Hub sem deixar referências de Hub B pending", async () => {
  await assertHubBUsableAfterHubAFailure(async context => {
    const outsideProject = join(context.root, "outside", "project-a");
    await expect(context.boot(context.hubA, outsideProject, "project-a"))
      .rejects.toThrow(/Projeto inicial fora da Raiz/);
  }, "resource-boot-failure-path-");
});
