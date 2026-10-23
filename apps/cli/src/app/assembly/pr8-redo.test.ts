import { copyFile, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { startApp } from "../server.ts";
import { fixtureAssembly } from "./fixture.ts";
import { pruneProject } from "./retention.ts";
import { compileScenes, validateProposal } from "./scenes.ts";
import { loadProject, saveProject } from "./store.ts";
import type { Project, Word } from "./types.ts";

const fechar: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of fechar.splice(0)) await close();
});

type Corpo = { project: Project; undoRevision: number | null; redoRevision: number | null };
type Resposta = Corpo & { status: number };

/** Sobe o app numa pasta; sem `dir`, cria uma com a fonte de teste. Reabrir a mesma pasta = reinício do servidor. */
async function subir(dir?: string) {
  const pasta = dir ?? await mkdtemp(join(tmpdir(), "pr8-redo-"));
  const clip = join(pasta, "fala.mp4");
  if (!dir) await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const app = await startApp({ projectDir: pasta, port: 0, selectFn: async () => ({ paths: [clip] }) });
  let aberto = true;
  const close = async () => { if (aberto) { aberto = false; await app.close(); } };
  fechar.push(close);
  return { dir: pasta, base: `http://127.0.0.1:${app.port}`, close };
}

async function obter(base: string): Promise<Corpo> {
  const res = await fetch(`${base}/project`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Corpo>;
}

async function post(base: string, path: string, body: unknown): Promise<Resposta> {
  const res = await fetch(`${base}/project/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

const cortadas = (project: Project): string[] => {
  const take = project.scenes[0]?.takes[0];
  const words = project.analyses[0]?.words ?? [];
  if (!take) return [];
  return words
    .filter((word) => take.removed.some((range) => range.start < word.end && word.start < range.end))
    .map((word) => word.id);
};

async function montar(dir: string, n: number): Promise<string> {
  const p = await loadProject(dir);
  const fonte = fixtureAssembly().sources[0]!;
  p.assembly = fixtureAssembly();
  p.assembly.sources = [{ ...fonte, durationSeconds: 30 }];
  p.assembly.tracks.forEach((track) => { track.clips = []; });
  const words: Word[] = Array.from({ length: n }, (_, i) => ({
    id: `w${i}`, sourceId: "a", start: i * 0.4, end: i * 0.4 + 0.3, text: `p${i}`, confidence: 0.9,
  }));
  p.analyses = [{
    sourceId: "a", key: "k", status: "ready",
    speech: [{ id: "a:s", sourceId: "a", start: 0, end: 20, text: "fala" }],
    visual: [], words, wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  p.scenes = validateProposal({
    id: "p", baseRevision: p.revision, changedSceneIds: ["s"], scenes: [{ id: "s", speechIds: ["a:s"] }],
  }, p).scenes;
  p.assembly = compileScenes(p, p.scenes);
  await saveProject(dir, p.revision, () => p);
  return p.scenes[0]!.takes[0]!.id;
}

async function tirar(base: string, takeId: string, wordId: string, baseRevision: number): Promise<number> {
  const res = await post(base, "edit", {
    baseRevision, action: { type: "remove", sceneId: "s", takeId, wordIds: [wordId] },
  });
  expect(res.status).toBe(200);
  return res.project.revision;
}

/** Edita cada palavra em ordem e devolve a revisão final. */
async function tirarTodas(base: string, takeId: string, n: number): Promise<number> {
  let revision = (await obter(base)).project.revision;
  for (let i = 0; i < n; i++) revision = await tirar(base, takeId, `w${i}`, revision);
  return revision;
}

async function desfazer(base: string): Promise<Resposta> {
  const atual = await obter(base);
  return post(base, "undo", { baseRevision: atual.project.revision, revision: atual.undoRevision });
}

async function refazer(base: string): Promise<Resposta> {
  const atual = await obter(base);
  return post(base, "redo", { baseRevision: atual.project.revision, revision: atual.redoRevision });
}

it("desfazer e refazer alternados mantêm a ordem, a revisão só cresce e os rótulos acompanham", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 3);
  await tirarTodas(base, takeId, 3);

  const passos: Array<{ conteudo: string[]; revision: number; desfazer?: string; refazer?: string }> = [];
  const registrar = async (res: Resposta) => {
    expect(res.status).toBe(200);
    const g = await obter(base);
    passos.push({
      conteudo: cortadas(g.project),
      revision: g.project.revision,
      desfazer: g.project.undo?.steps.at(-1)?.label,
      refazer: g.project.undo?.redo?.at(-1)?.label,
    });
  };
  await registrar(await desfazer(base));
  await registrar(await desfazer(base));
  await registrar(await refazer(base));
  await registrar(await desfazer(base));
  await registrar(await refazer(base));
  await registrar(await refazer(base));

  const conteudos = passos.map((p) => p.conteudo);
  const revisoes = passos.map((p) => p.revision);
  expect(conteudos).toEqual([["w0", "w1"], ["w0"], ["w0", "w1"], ["w0"], ["w0", "w1"], ["w0", "w1", "w2"]]);
  expect(revisoes.every((r, i) => r > (revisoes[i - 1] ?? 3))).toBe(true);
  expect(passos.map((p) => [p.desfazer ?? null, p.refazer ?? null])).toEqual([
    ["Tirar trecho", "Tirar trecho"],
    ["Tirar trecho", "Tirar trecho"],
    ["Tirar trecho", "Tirar trecho"],
    ["Tirar trecho", "Tirar trecho"],
    ["Tirar trecho", "Tirar trecho"],
    ["Tirar trecho", null],
  ]);
});

it("o rótulo do refazer é o da edição desfeita", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 2);
  const rev = await tirar(base, takeId, "w0", 0);
  const apagada = await post(base, "edit", { baseRevision: rev, action: { type: "delete-scene", sceneId: "s" } });
  expect(apagada.status).toBe(200);
  const res = await desfazer(base);
  expect(res.status).toBe(200);
  const g = await obter(base);
  expect({ cenas: g.project.scenes.length, redo: g.project.undo?.redo?.map((p) => p.label), redoRevision: g.redoRevision }).toEqual({
    cenas: 1,
    redo: ["Apagar cena"],
    redoRevision: g.project.undo?.redo?.at(-1)?.revision ?? null,
  });
  expect(g.redoRevision).not.toBeNull();
  const refeito = await refazer(base);
  expect(refeito.status).toBe(200);
  expect((await obter(base)).project.scenes).toHaveLength(0);
});

it("nova edição depois de desfazer encerra o Refazer", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 3);
  await tirarTodas(base, takeId, 2);
  expect((await desfazer(base)).status).toBe(200);
  const antes = await obter(base);
  expect(antes.redoRevision).not.toBeNull();

  await tirar(base, takeId, "w2", antes.project.revision);
  const depois = await obter(base);
  const tentativa = await post(base, "redo", { baseRevision: depois.project.revision, revision: antes.redoRevision });
  expect({
    redoRevision: depois.redoRevision,
    ramo: depois.project.undo?.redo,
    status: tentativa.status,
    corte: cortadas((await obter(base)).project),
  }).toEqual({ redoRevision: null, ramo: undefined, status: 409, corte: ["w0", "w2"] });
});

it("revisão que anda por fora (briefing, renomear) encerra o Refazer e o conteúdo fica intacto", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 3);
  await tirarTodas(base, takeId, 2);
  expect((await desfazer(base)).status).toBe(200);
  const alvo = (await obter(base)).redoRevision!;

  const rev1 = (await obter(base)).project.revision;
  const input = await post(base, "input", { baseRevision: rev1, kind: "brief", text: "briefing novo", targetSeconds: 60 });
  expect(input.status).toBe(200);
  const aposInput = await obter(base);
  const redoInput = await post(base, "redo", { baseRevision: aposInput.project.revision, revision: alvo });

  const rename = await post(base, "rename", { baseRevision: aposInput.project.revision, nome: "Nome novo" });
  expect(rename.status).toBe(200);
  const aposRename = await obter(base);
  const redoRename = await post(base, "redo", { baseRevision: aposRename.project.revision, revision: alvo });

  expect({
    aposInput: { redoRevision: aposInput.redoRevision, status: redoInput.status },
    aposRename: { redoRevision: aposRename.redoRevision, status: redoRename.status },
    corte: cortadas(aposRename.project),
    texto: aposRename.project.input.text,
    nome: aposRename.project.assembly.name,
  }).toEqual({
    aposInput: { redoRevision: null, status: 409 },
    aposRename: { redoRevision: null, status: 409 },
    corte: ["w0"],
    texto: "briefing novo",
    nome: "Nome novo",
  });
});

it("redo com baseRevision velha responde 409 e não muda o projeto", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 2);
  await tirarTodas(base, takeId, 2);
  expect((await desfazer(base)).status).toBe(200);
  const atual = await obter(base);
  const res = await post(base, "redo", { baseRevision: atual.project.revision - 1, revision: atual.redoRevision });
  const depois = await obter(base);
  expect({ status: res.status, revision: depois.project.revision, corte: cortadas(depois.project), redoRevision: depois.redoRevision })
    .toEqual({ status: 409, revision: atual.project.revision, corte: ["w0"], redoRevision: atual.redoRevision });
});

it("redo sem revision válida responde 400 e sem ramo responde 409", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 2);
  const rev = await tirar(base, takeId, "w0", 0);
  const invalida = await post(base, "redo", { baseRevision: rev, revision: -1 });
  const vazio = await post(base, "redo", { baseRevision: rev, revision: 0 });
  expect({ invalida: invalida.status, vazio: vazio.status }).toEqual({ invalida: 400, vazio: 409 });
});

it("redo de uma revisão que não é o topo do ramo responde 409", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 3);
  await tirarTodas(base, takeId, 3);
  expect((await desfazer(base)).status).toBe(200);
  expect((await desfazer(base)).status).toBe(200);
  const g = await obter(base);
  const ramo = g.project.undo!.redo!;
  const fundo = await post(base, "redo", { baseRevision: g.project.revision, revision: ramo[0]!.revision });
  expect({ ramo: ramo.length, status: fundo.status, corte: cortadas((await obter(base)).project) })
    .toEqual({ ramo: 2, status: 409, corte: ["w0"] });
});

it("o ramo guarda no máximo 20: 21 edições, desfazer tudo e refazer tudo recupera as 20 e o 21º é 409", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 21);
  await tirarTodas(base, takeId, 21);

  let desfeitos = 0;
  for (;;) {
    const res = await desfazer(base);
    if (res.status !== 200) break;
    desfeitos++;
  }
  expect(desfeitos).toBe(20);
  expect(cortadas((await obter(base)).project)).toEqual(["w0"]);

  let refeitos = 0;
  let ultimo = 0;
  for (;;) {
    const res = await refazer(base);
    if (res.status !== 200) { ultimo = res.status; break; }
    refeitos++;
  }
  const final = await obter(base);
  expect({ refeitos, ultimo, cortes: cortadas(final.project).length, redoRevision: final.redoRevision })
    .toEqual({ refeitos: 20, ultimo: 409, cortes: 21, redoRevision: null });
});

it("GC preserva as fotos do Refazer: editar, desfazer, podar e refazer tudo", async () => {
  const { dir, base } = await subir();
  const takeId = await montar(dir, 4);
  await tirarTodas(base, takeId, 4);
  for (let i = 0; i < 3; i++) expect((await desfazer(base)).status).toBe(200);

  const ramo = (await loadProject(dir)).undo!.redo!.map((p) => p.revision);
  await pruneProject(dir, { revisions: 0 });
  const existem = await Promise.all(ramo.map((n) => access(join(dir, "history", `rev-${n}.json`)).then(() => true, () => false)));

  let refeitos = 0;
  for (;;) {
    const res = await refazer(base);
    if (res.status !== 200) break;
    refeitos++;
  }
  expect({ ramo: ramo.length, existem, refeitos, corte: cortadas((await obter(base)).project) })
    .toEqual({ ramo: 3, existem: [true, true, true], refeitos: 3, corte: ["w0", "w1", "w2", "w3"] });
});

it("versão anterior: project.json sem o campo redo abre e só o Refazer some", async () => {
  const { dir, base, close } = await subir();
  const takeId = await montar(dir, 3);
  await tirarTodas(base, takeId, 2);
  expect((await desfazer(base)).status).toBe(200);
  const antes = await obter(base);
  expect(antes.redoRevision).not.toBeNull();
  await close();

  const file = join(dir, "project.json");
  const gravado = JSON.parse(await readFile(file, "utf8")) as Project;
  const { redo: _redo, ...semRedo } = gravado.undo!;
  await writeFile(file, JSON.stringify({ ...gravado, undo: semRedo }));

  const novo = await subir(dir);
  const depois = await obter(novo.base);
  expect({
    cortes: cortadas(depois.project),
    redoRevision: depois.redoRevision,
    undoRevision: depois.undoRevision,
    redo: depois.project.undo?.redo,
  }).toEqual({ cortes: ["w0"], redoRevision: null, undoRevision: antes.undoRevision, redo: undefined });
  expect((await desfazer(novo.base)).status).toBe(200);
});
