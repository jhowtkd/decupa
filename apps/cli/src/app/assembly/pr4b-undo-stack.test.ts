import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import type { LegacyProject } from "./types.ts";
import { createProject, loadProject } from "./store.ts";

async function abrirComUndo(undo: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pr4b-undo-stack-"));
  const assembly = fixtureAssembly();
  const legacy: LegacyProject = {
    version: 1,
    id: "p1",
    revision: 5,
    input: { kind: "brief", text: "contar o tema", targetSeconds: 60 },
    assembly,
    scenes: [],
    analyses: [],
    proposal: null,
    structureApprovedRevision: null,
    previewRevision: null,
    finalApprovedRevision: null,
  };
  await createProject(dir, legacy);
  const file = join(dir, "project.json");
  const gravado = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...gravado, undo }));
  return loadProject(dir);
}

const passo = (revision: number, label: string) => ({ revision, label });

it.each([
  ["revisão >= head", { head: 2, steps: [passo(99999, "x")] }],
  ["revisão repetida", { head: 5, steps: [passo(3, "a"), passo(3, "b")] }],
  ["fora de ordem", { head: 5, steps: [passo(4, "a"), passo(2, "b")] }],
  ["revisão igual a head", { head: 5, steps: [passo(5, "a")] }],
])("pilha inválida (%s) vira sem desfazer e o projeto abre", async (_nome, undo) => {
  const project = await abrirComUndo(undo);
  expect(project.undo).toBeUndefined();
});

it.each([
  ["passos crescentes abaixo de head", { head: 5, steps: [passo(2, "a"), passo(4, "b")] }],
  ["pilha vazia em head 0", { head: 0, steps: [] as unknown[] }],
])("pilha válida (%s) é mantida", async (_nome, undo) => {
  const project = await abrirComUndo(undo);
  expect(project.undo).toEqual(undo);
});
