import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { startApp } from "./server.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function exerciseProjectScope(useSharedMedia: boolean) {
  const parent = await mkdtemp(join(tmpdir(), "resource-boot-open-scope-"));
  roots.push(parent);
  const sharedMedia = useSharedMedia ? join(parent, "shared-media") : undefined;
  const projectsRoot = join(parent, "projects");
  const projectDir = join(projectsRoot, "principal");
  const openedDir = join(projectsRoot, "aberto");
  const untouchedDir = join(projectsRoot, "intocado");
  const assembly = fixtureAssembly();
  for (const [dir, id, sha] of [
    [projectDir, "principal", "c".repeat(64)],
    [openedDir, "aberto", "d".repeat(64)],
    [untouchedDir, "intocado", "e".repeat(64)],
  ] as const) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({
      ...blankProject(id),
      assembly: { ...assembly, sources: assembly.sources.map(source => ({ ...source, sha256: sha })) },
    }));
  }
  const app = await startApp({
    projectsRoot, projectDir, projectId: "principal", ledgerScope: "project", port: 0, autoStart: false,
    env: sharedMedia ? { DECUPA_MEDIA_ROOT: sharedMedia } : {},
  });
  const base = `http://127.0.0.1:${app.port}`;
  let createdDir = "";
  try {
    const opened = await fetch(`${base}/projects/aberto/project`);
    expect(opened.status).toBe(200);
    const created = await fetch(`${base}/project/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Novo aberto", fluxo: "montagem" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string };
    createdDir = join(projectsRoot, body.id);
    const { mediaKey, resourceLedgerForProject } = await import("./resource-ledger.ts");
    const deadline = Date.now() + 5000;
    for (const [dir, sha] of [
      [projectDir, "c".repeat(64)], [openedDir, "d".repeat(64)], [createdDir, "c".repeat(64)],
    ] as const) {
      for (;;) {
        try {
          await resourceLedgerForProject(dir).references(mediaKey(sha));
          break;
        } catch (error) {
          if (!(error instanceof Error) || !/incompleto/.test(error.message) || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    }
  } finally {
    await app.close();
  }

  if (sharedMedia) {
    const snapshot = JSON.parse(await readFile(join(sharedMedia, ".decupa", "references.json"), "utf8")) as {
      entries: { owner: { id: string } }[];
    };
    expect(snapshot.entries.map(entry => entry.owner.id)).toEqual(expect.arrayContaining([
      `project:${projectDir}`, `project:${openedDir}`, `project:${createdDir}`,
    ]));
    expect(snapshot.entries.map(entry => entry.owner.id)).not.toContain(`project:${untouchedDir}`);
    await expect(readFile(join(parent, ".decupa", "references.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    for (const dir of [projectsRoot, projectDir, openedDir, createdDir, untouchedDir]) {
      await expect(readFile(join(dir, ".decupa", "references.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  } else {
    for (const dir of [projectDir, openedDir, createdDir]) {
      await readFile(join(dir, ".decupa", "references.json"), "utf8");
    }
    for (const dir of [projectsRoot, untouchedDir]) {
      await expect(readFile(join(dir, ".decupa", "references.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(join(parent, ".decupa", "references.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  }
  expect((await readdir(projectsRoot)).sort()).toContain("intocado");
}

it("escopa projetos abertos/criados ao MEDIA_ROOT e ignora irmãos não abertos", async () => {
  await exerciseProjectScope(true);
});

it("sem MEDIA_ROOT, guarda índices locais só nos Projetos abertos/criados", async () => {
  await exerciseProjectScope(false);
});
