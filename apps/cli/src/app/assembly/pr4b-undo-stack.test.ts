import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import type { LegacyProject } from "./types.ts";
import { createProject, loadProject } from "./store.ts";

const pastas: string[] = [];
afterEach(async () => {
  for (const pasta of pastas.splice(0)) await rm(pasta, { recursive: true, force: true });
});

async function abrirComUndo(undo: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pr4b-undo-stack-"));
  pastas.push(dir);
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

it.each([
  ["não é lista", { head: 5, steps: [passo(2, "a")], redo: "x" }],
  ["revisão >= head", { head: 5, steps: [passo(2, "a")], redo: [passo(5, "b")] }],
  ["revisão acima de head", { head: 5, steps: [passo(2, "a")], redo: [passo(99999, "b")] }],
  ["decrescente", { head: 5, steps: [passo(2, "a")], redo: [passo(4, "b"), passo(3, "c")] }],
  ["label não é texto", { head: 5, steps: [passo(2, "a")], redo: [{ revision: 3, label: 7 }] }],
  ["passo não é objeto", { head: 5, steps: [passo(2, "a")], redo: [null] }],
])("refazer inválido (%s) some e os passos do desfazer ficam", async (_nome, undo) => {
  const project = await abrirComUndo(undo);
  expect(project.undo).toEqual({ head: 5, steps: [passo(2, "a")] });
});

it("refazer válido é mantido e refazer vazio não é gravado", async () => {
  const comRamo = await abrirComUndo({ head: 5, steps: [passo(2, "a")], redo: [passo(3, "b"), passo(4, "c")] });
  const vazio = await abrirComUndo({ head: 5, steps: [passo(2, "a")], redo: [] });
  expect({ comRamo: comRamo.undo, vazio: vazio.undo }).toEqual({
    comRamo: { head: 5, steps: [passo(2, "a")], redo: [passo(3, "b"), passo(4, "c")] },
    vazio: { head: 5, steps: [passo(2, "a")] },
  });
});

it("projeto no formato antigo (sem redo) abre com os passos intactos", async () => {
  const project = await abrirComUndo({ head: 5, steps: [passo(2, "a"), passo(4, "b")] });
  expect(project.undo).toEqual({ head: 5, steps: [passo(2, "a"), passo(4, "b")] });
});

const seq = (de: number, ate: number, rotulo: string) =>
  Array.from({ length: ate - de + 1 }, (_, i) => passo(de + i, `${rotulo}${de + i}`));

it("refazer que cruza com os passos do desfazer some e os passos ficam", async () => {
  const project = await abrirComUndo({ head: 9, steps: [passo(2, "a"), passo(4, "b")], redo: [passo(4, "c"), passo(6, "d")] });
  expect(project.undo).toEqual({ head: 9, steps: [passo(2, "a"), passo(4, "b")] });
});

it("passos + refazer acima de 20 descartam o refazer; exatamente 20 mantém os dois", async () => {
  const passos = seq(1, 10, "s");
  const demais = await abrirComUndo({ head: 99, steps: passos, redo: seq(11, 21, "r") });
  const exato = await abrirComUndo({ head: 99, steps: passos, redo: seq(11, 20, "r") });
  expect({ demais: demais.undo, exato: exato.undo }).toEqual({
    demais: { head: 99, steps: passos },
    exato: { head: 99, steps: passos, redo: seq(11, 20, "r") },
  });
});
