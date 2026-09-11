import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import type { Project } from "./types.ts";
import { createProject, loadProject, missingMedia, saveProject } from "./store.ts";

function projectAt(revision: number): Project {
  const assembly = fixtureAssembly();
  assembly.revision = revision;
  return {
    version: 1,
    id: "p1",
    revision,
    input: { kind: "brief", text: "contar o tema", targetSeconds: 60 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
}

it("recusa segunda escrita com a mesma base e mantém a revisão 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const next = projectAt(2);
  await saveProject(dir, 1, next);
  await expect(saveProject(dir, 1, next)).rejects.toThrow(/revisão/);
  expect((await loadProject(dir)).revision).toBe(2);
});

it("createProject não sobrescreve um projeto existente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  await expect(createProject(dir, projectAt(1))).rejects.toThrow(/existe/);
  expect((await loadProject(dir)).revision).toBe(1);
});

it("reabre o projeto depois de mudar só o briefing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const next = projectAt(2);
  next.input = { kind: "script", text: "cena 1", targetSeconds: 30 };
  await saveProject(dir, 1, next);
  const loaded = await loadProject(dir);
  expect(loaded.input.text).toBe("cena 1");
  expect(loaded.revision).toBe(2);
});

it("carrega o projeto mesmo com mídia ausente e nomeia as fontes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  const loaded = await loadProject(dir);
  const missing = await missingMedia(loaded);
  expect(missing.map((s) => s.id).sort()).toEqual(["a", "b"]);
  expect(missing[0]!.path).toContain("decupa-fixture");
});

it("recusa lock vivo de outro pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  await writeFile(join(dir, "project.lock"), `${process.pid}\n`, "utf8");
  await expect(saveProject(dir, 1, projectAt(2))).rejects.toThrow(/processo|lock|escreve/i);
});

it("libera lock abandonado depois de conferir o pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  await createProject(dir, projectAt(1));
  await writeFile(join(dir, "project.lock"), "99999999\n", "utf8");
  await saveProject(dir, 1, projectAt(2));
  expect((await loadProject(dir)).revision).toBe(2);
});

it("não deixa snapshot antigo na mesma revisão apagar aprovação", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-store-"));
  const initial = projectAt(3);
  initial.analyses = [{
    sourceId: "a",
    key: "k",
    speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 1, text: "olá" }],
    visual: [],
    status: "ready",
  }];
  await createProject(dir, initial);
  const snap = await loadProject(dir);
  await saveProject(dir, 3, { ...snap, structureApprovedRevision: 3 });
  await saveProject(dir, 3, { ...snap, analyses: [] });
  const loaded = await loadProject(dir);
  expect(loaded.revision).toBe(3);
  expect(loaded.structureApprovedRevision).toBe(3);
  expect(loaded.analyses).toHaveLength(1);
  expect(loaded.analyses[0]!.sourceId).toBe("a");
});
