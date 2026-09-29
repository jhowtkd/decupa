import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { startApp } from "../server.ts";
import { fixtureAssembly } from "./fixture.ts";
import { compileScenes, validateProposal } from "./scenes.ts";
import { loadProject, saveProject } from "./store.ts";
import type { Project, Word } from "./types.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "pr4b-undo-"));
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const app = await startApp({
    projectDir: dir,
    port: 0,
    selectFn: async () => ({ paths: [clip] }),
  });
  stop = app.close;
  return { dir, base: `http://127.0.0.1:${app.port}` };
}

type Corpo = { project: Project; undoRevision: number | null };

async function obter(base: string): Promise<Corpo> {
  const res = await fetch(`${base}/project`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Corpo>;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; project: Project; undoRevision: number | null }> {
  const res = await fetch(`${base}/project/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const texto = await res.text();
  const json = texto ? JSON.parse(texto) as { project?: Project; undoRevision?: number | null } : {};
  return { status: res.status, project: json.project ?? ({} as Project), undoRevision: json.undoRevision ?? null };
}

/** Palavras cujo intervalo cai dentro de um corte do take. */
function cortadas(project: Project): string[] {
  const take = project.scenes[0]?.takes[0];
  const words = project.analyses[0]?.words ?? [];
  if (!take) return [];
  return words
    .filter((word) => take.removed.some((range) => range.start < word.end && word.start < range.end))
    .map((word) => word.id);
}

/** Cena com N palavras encostadas, para o corte de cada uma ser um intervalo próprio. */
async function montar(dir: string, n: number): Promise<string> {
  const p = await loadProject(dir);
  const fonte = fixtureAssembly().sources[0]!;
  p.assembly = fixtureAssembly();
  p.assembly.sources = [{ ...fonte, durationSeconds: 30 }];
  p.assembly.tracks.forEach((track) => { track.clips = []; });
  const words: Word[] = Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    sourceId: "a",
    start: i * 0.4,
    end: i * 0.4 + 0.3,
    text: `p${i}`,
    confidence: 0.9,
  }));
  p.analyses = [{
    sourceId: "a",
    key: "k",
    status: "ready",
    speech: [{ id: "a:s", sourceId: "a", start: 0, end: 20, text: "fala" }],
    visual: [],
    words,
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  p.scenes = validateProposal({
    id: "p",
    baseRevision: p.revision,
    changedSceneIds: ["s"],
    scenes: [{ id: "s", speechIds: ["a:s"] }],
  }, p).scenes;
  p.assembly = compileScenes(p, p.scenes);
  await saveProject(dir, p.revision, () => p);
  return p.scenes[0]!.takes[0]!.id;
}

async function tirar(base: string, takeId: string, wordId: string, baseRevision: number) {
  const res = await post(base, "edit", {
    baseRevision,
    action: { type: "remove", sceneId: "s", takeId, wordIds: [wordId] },
  });
  expect(res.status).toBe(200);
  return res.project.revision;
}

it("três edições desfazem um passo por vez e nunca reaplicam o que saiu", async () => {
  const { dir, base } = await boot();
  const takeId = await montar(dir, 4);
  let revision = 0;
  for (const wordId of ["w0", "w1", "w2"]) revision = await tirar(base, takeId, wordId, revision);
  expect(cortadas((await obter(base)).project)).toEqual(["w0", "w1", "w2"]);

  const trilha: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const atual = await obter(base);
    const res = await post(base, "undo", { baseRevision: atual.project.revision, revision: atual.undoRevision });
    expect(res.status).toBe(200);
    trilha.push(cortadas(res.project));
  }
  expect(trilha).toEqual([["w0", "w1"], ["w0"], []]);
});

it("GET aponta o desfazer para o topo e o rótulo diz o que será desfeito", async () => {
  const { dir, base } = await boot();
  const takeId = await montar(dir, 2);
  await tirar(base, takeId, "w0", 0);
  const corte = await obter(base);
  const apagada = await post(base, "edit", {
    baseRevision: corte.project.revision,
    action: { type: "delete-scene", sceneId: "s" },
  });
  expect(apagada.status).toBe(200);
  const cena = await obter(base);
  const rotulo = (project: Project) => project.undo?.steps.at(-1)?.label ?? null;
  expect({
    corte: { undoRevision: corte.undoRevision, label: rotulo(corte.project) },
    cena: { undoRevision: cena.undoRevision, label: rotulo(cena.project), cenas: cena.project.scenes.length },
  }).toEqual({
    corte: { undoRevision: 0, label: "Tirar trecho" },
    cena: { undoRevision: 1, label: "Apagar cena", cenas: 0 },
  });
});

it("a pilha guarda no máximo 20 passos: o 21º desfazer não volta a primeira foto", async () => {
  const { dir, base } = await boot();
  const takeId = await montar(dir, 21);
  let revision = 0;
  for (let i = 0; i < 21; i++) revision = await tirar(base, takeId, `w${i}`, revision);
  expect(cortadas((await obter(base)).project)).toHaveLength(21);

  const contagens: number[] = [];
  let extra = 0;
  for (let i = 0; i < 21; i++) {
    const atual = await obter(base);
    const res = await post(base, "undo", { baseRevision: atual.project.revision, revision: atual.undoRevision });
    if (res.status !== 200) {
      extra = res.status;
      break;
    }
    contagens.push(cortadas(res.project).length);
  }
  // 21 cortes, 20 fotos: cada desfazer tira um, e o que sobra é o primeiro corte.
  expect({ contagens, extra }).toEqual({
    contagens: Array.from({ length: 20 }, (_, i) => 20 - i),
    extra: 409,
  });
});

it("mudança de revisão sem foto quebra a pilha: desfazer a revisão antiga não restaura", async () => {
  const { dir, base } = await boot();
  const takeId = await montar(dir, 2);
  const revision = await tirar(base, takeId, "w0", 0);
  const input = await post(base, "input", {
    baseRevision: revision,
    kind: "brief",
    text: "briefing novo",
    targetSeconds: 60,
  });
  expect(input.status).toBe(200);
  const antes = await obter(base);
  const desfazer = await post(base, "undo", { baseRevision: antes.project.revision, revision: 0 });
  const depois = desfazer.status === 200 ? desfazer.project : (await obter(base)).project;
  expect({
    undoRevision: antes.undoRevision,
    status: desfazer.status,
    texto: depois.input.text,
    corte: cortadas(depois),
  }).toEqual({ undoRevision: null, status: 409, texto: "briefing novo", corte: ["w0"] });
});

it("histórico corrompido responde 200 com desfazer vazio", async () => {
  const { dir, base } = await boot();
  const takeId = await montar(dir, 2);
  await tirar(base, takeId, "w0", 0);
  await writeFile(join(dir, "history", "rev-0.json"), "{quebrado");
  const res = await fetch(`${base}/project`);
  const texto = await res.text();
  const undoRevision = res.status === 200 ? (JSON.parse(texto) as Corpo).undoRevision : null;
  expect({ status: res.status, undoRevision }).toEqual({ status: 200, undoRevision: null });
});
