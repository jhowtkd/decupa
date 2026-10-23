// Arraste de cenas: reorder-scenes é um pedido, uma revisão e um passo; a ordem
// igual não grava; ordem inválida não mexe no projeto.
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { startApp } from "../server.ts";
import { fixtureAssembly } from "./fixture.ts";
import { compileScenes, validateProposal } from "./scenes.ts";
import { loadProject, saveProject } from "./store.ts";
import type { Project } from "./types.ts";

const fechar: Array<() => Promise<void>> = [];
const pastas: string[] = [];
afterEach(async () => {
  for (const close of fechar.splice(0)) await close();
  // Só as pastas que este arquivo criou, e só depois de fechar os apps.
  for (const pasta of pastas.splice(0)) await rm(pasta, { recursive: true, force: true });
});

type Corpo = { project: Project; undoRevision: number | null; redoRevision: number | null };
type Resposta = Corpo & { status: number };

async function subir() {
  const pasta = await mkdtemp(join(tmpdir(), "pr9-reordenar-"));
  pastas.push(pasta);
  const clip = join(pasta, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const app = await startApp({ projectDir: pasta, port: 0, selectFn: async () => ({ paths: [clip] }) });
  let aberto = true;
  fechar.push(async () => { if (aberto) { aberto = false; await app.close(); } });
  return { dir: pasta, base: `http://127.0.0.1:${app.port}` };
}

async function obter(base: string): Promise<Corpo> {
  const res = await fetch(`${base}/project`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Corpo>;
}

async function post(base: string, path: string, body: unknown): Promise<Resposta> {
  const res = await fetch(`${base}/project/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const texto = await res.text();
  const json = texto ? JSON.parse(texto) as Partial<Corpo> : {};
  return {
    status: res.status,
    project: json.project ?? ({} as Project),
    undoRevision: json.undoRevision ?? null,
    redoRevision: json.redoRevision ?? null,
  };
}

const IDS = ["s1", "s2", "s3", "s4", "s5"];

/** Cinco cenas (uma fala de 2 s cada, em sequência). */
async function montar(dir: string): Promise<void> {
  const p = await loadProject(dir);
  const fonte = fixtureAssembly().sources[0]!;
  p.assembly = fixtureAssembly();
  p.assembly.sources = [{ ...fonte, durationSeconds: 30 }];
  p.assembly.tracks.forEach((track) => { track.clips = []; });
  p.analyses = [{
    sourceId: "a", key: "k", status: "ready",
    speech: IDS.map((id, i) => ({ id: `a:${id}`, sourceId: "a", start: i * 3, end: i * 3 + 2, text: `fala ${id}` })),
    visual: [], words: [], wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  p.scenes = validateProposal({
    id: "p", baseRevision: p.revision, changedSceneIds: IDS,
    scenes: IDS.map((id) => ({ id, speechIds: [`a:${id}`] })),
  }, p).scenes;
  p.assembly = compileScenes(p, p.scenes);
  await saveProject(dir, p.revision, () => p);
}

const ordem = (p: Project) => p.scenes.map((s) => s.id);
/** Ordem em que os clipes de vídeo do assembly apontam para as falas. */
const ordemCompilada = (p: Project) =>
  p.assembly.tracks.flatMap((track) => track.clips).map((clip) => JSON.stringify(clip)).join("|");
const fotos = async (dir: string) =>
  (await readdir(join(dir, "history")).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
const reordenar = (base: string, baseRevision: number, order: unknown) =>
  post(base, "edit", { baseRevision, action: { type: "reorder-scenes", order } });

async function desfazer(base: string) {
  const g = await obter(base);
  return post(base, "undo", { baseRevision: g.project.revision, revision: g.undoRevision });
}
async function refazer(base: string) {
  const g = await obter(base);
  return post(base, "redo", { baseRevision: g.project.revision, revision: g.redoRevision });
}

it("mover uma cena várias posições é um pedido: revisão +1, um passo \"Mover cena\" e assembly recompilado", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  const antes = await obter(base);
  const passosAntes = antes.project.undo?.steps.length ?? 0;
  const compiladoAntes = ordemCompilada(antes.project);

  const res = await reordenar(base, antes.project.revision, ["s2", "s3", "s4", "s5", "s1"]);
  const depois = await obter(base);
  expect({
    status: res.status,
    revision: depois.project.revision,
    ordem: ordem(depois.project),
    passos: depois.project.undo!.steps.length - passosAntes,
    rotulo: depois.project.undo!.steps.at(-1)!.label,
    recompilado: ordemCompilada(depois.project) !== compiladoAntes,
  }).toEqual({
    status: 200, revision: antes.project.revision + 1, ordem: ["s2", "s3", "s4", "s5", "s1"],
    passos: 1, rotulo: "Mover cena", recompilado: true,
  });
  expect(ordem(res.project)).toEqual(["s2", "s3", "s4", "s5", "s1"]);
});

it("desfazer devolve a ordem inteira e refazer a reaplica", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  const antes = await obter(base);
  await reordenar(base, antes.project.revision, ["s4", "s1", "s2", "s3", "s5"]);

  expect((await desfazer(base)).status).toBe(200);
  const desfeito = await obter(base);
  expect(ordem(desfeito.project)).toEqual(IDS);
  expect(ordemCompilada(desfeito.project)).toBe(ordemCompilada(antes.project));
  expect(desfeito.project.undo?.redo?.at(-1)?.label).toBe("Mover cena");

  expect((await refazer(base)).status).toBe(200);
  expect(ordem((await obter(base)).project)).toEqual(["s4", "s1", "s2", "s3", "s5"]);
});

it("reordenar depois de desfazer encerra o ramo de Refazer", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  const g0 = await obter(base);
  await reordenar(base, g0.project.revision, ["s2", "s1", "s3", "s4", "s5"]);
  expect((await desfazer(base)).status).toBe(200);
  const ramo = await obter(base);
  expect(ramo.redoRevision).not.toBeNull();

  expect((await reordenar(base, ramo.project.revision, ["s5", "s1", "s2", "s3", "s4"])).status).toBe(200);
  const depois = await obter(base);
  const tentativa = await post(base, "redo", { baseRevision: depois.project.revision, revision: ramo.redoRevision });
  expect({ redoRevision: depois.redoRevision, ramo: depois.project.undo?.redo, status: tentativa.status, ordem: ordem((await obter(base)).project) })
    .toEqual({ redoRevision: null, ramo: undefined, status: 409, ordem: ["s5", "s1", "s2", "s3", "s4"] });
});

it("a ordem igual devolve 200 com o projeto atual, sem revisão, sem passo e sem foto nova", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  // Já com uma edição gravada: há foto em history/ para comparar.
  await reordenar(base, 0, ["s3", "s1", "s2", "s4", "s5"]);
  const antes = await obter(base);
  const fotosAntes = await fotos(dir);
  expect(fotosAntes.length).toBeGreaterThan(0);

  const res = await reordenar(base, antes.project.revision, ["s3", "s1", "s2", "s4", "s5"]);
  const depois = await obter(base);
  expect({
    status: res.status,
    revisaoResposta: res.project.revision,
    revision: depois.project.revision,
    undo: depois.project.undo,
    undoRevision: depois.undoRevision,
    fotos: await fotos(dir),
  }).toEqual({
    status: 200, revisaoResposta: antes.project.revision, revision: antes.project.revision,
    undo: antes.project.undo, undoRevision: antes.undoRevision, fotos: fotosAntes,
  });
});

it("a ordem igual não encerra um ramo de Refazer existente", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  const g0 = await obter(base);
  await reordenar(base, g0.project.revision, ["s2", "s1", "s3", "s4", "s5"]);
  await desfazer(base);
  const ramo = await obter(base);
  await reordenar(base, ramo.project.revision, IDS);
  expect((await obter(base)).redoRevision).toBe(ramo.redoRevision);
});

it.each([
  ["cena faltando", ["s1", "s2", "s3", "s4"], 400],
  ["id desconhecido", ["s1", "s2", "s3", "s4", "s5", "x9"], 400],
  ["id desconhecido no lugar de outro", ["s1", "s2", "s3", "s4", "x9"], 400],
  ["cena duplicada", ["s1", "s2", "s3", "s4", "s4"], 400],
  ["lista vazia", [], 400],
  ["order não-array", "s1,s2,s3,s4,s5", 400],
  ["order ausente", undefined, 400],
])("ordem inválida (%s) dá 400 e o projeto fica intacto", async (_nome, order, status) => {
  const { dir, base } = await subir();
  await montar(dir);
  const antes = await obter(base);
  const fotosAntes = await fotos(dir);

  const res = await reordenar(base, antes.project.revision, order);
  const depois = await obter(base);
  expect({ status: res.status, revision: depois.project.revision, ordem: ordem(depois.project), undo: depois.project.undo, fotos: await fotos(dir) })
    .toEqual({ status, revision: antes.project.revision, ordem: IDS, undo: antes.project.undo, fotos: fotosAntes });
});

it("base velha dá 409 e não grava", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  await reordenar(base, 0, ["s3", "s1", "s2", "s4", "s5"]);
  const antes = await obter(base);
  const res = await reordenar(base, antes.project.revision - 1, ["s2", "s1", "s3", "s4", "s5"]);
  const depois = await obter(base);
  expect({ status: res.status, revision: depois.project.revision, ordem: ordem(depois.project) })
    .toEqual({ status: 409, revision: antes.project.revision, ordem: ["s3", "s1", "s2", "s4", "s5"] });
});

it("a base velha com a mesma ordem também é 409 (não vira 200 vazio)", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  await reordenar(base, 0, ["s3", "s1", "s2", "s4", "s5"]);
  const antes = await obter(base);
  const res = await reordenar(base, antes.project.revision - 1, ["s3", "s1", "s2", "s4", "s5"]);
  expect(res.status).toBe(409);
});

it("o move-scene continua funcionando: uma posição, um passo", async () => {
  const { dir, base } = await subir();
  await montar(dir);
  const antes = await obter(base);
  const res = await post(base, "edit", { baseRevision: antes.project.revision, action: { type: "move-scene", sceneId: "s1", direction: "down" } });
  const depois = await obter(base);
  expect({ status: res.status, ordem: ordem(depois.project), revision: depois.project.revision, rotulo: depois.project.undo!.steps.at(-1)!.label })
    .toEqual({ status: 200, ordem: ["s2", "s1", "s3", "s4", "s5"], revision: antes.project.revision + 1, rotulo: "Mover cena" });
});
