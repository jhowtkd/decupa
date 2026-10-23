// A legenda por revisão (GET project/subtitles/<rev>/<vtt|srt|json>): a rota
// entrega o que a exportação grava, a prévia antiga leva a legenda dela ou
// 404 com motivo, e corte, correção e reordenação mudam a legenda.
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { startApp } from "../server.ts";
import { pedidoDeFormato } from "./editor/studio-formato.js";
import { fixtureAssembly } from "./fixture.ts";
import { applyEdit } from "./revisions.ts";
import { compileScenes, validateProposal } from "./scenes.ts";
import { loadProject, saveProject } from "./store.ts";
import { subtitleRecord } from "./subtitles.ts";
import { settleCorrection } from "./words.ts";
import type { Project, Word } from "./types.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await fechar(); });

async function fechar() {
  const parar = stop;
  stop = null;
  await parar?.();
}

type Cue = { startMs: number; endMs: number; text: string };
type Json = { revision: number; origem: string; legendas: { status: string; vttSha?: string; srtSha?: string; motivo?: string }; cues: Cue[] };

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "legendas-rev-"));
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const app = await startApp({ projectDir: dir, port: 0, selectFn: async () => ({ paths: [clip] }) });
  stop = app.close;
  return { dir, base: `http://127.0.0.1:${app.port}` };
}

const palavra = (i: number, start: number, text: string): Word => ({
  id: `w${i}`, sourceId: "a", start, end: start + 0.3, text, confidence: 0.9,
});

/**
 * Duas cenas da mesma fonte: "s1" fala `alfa beta gama.` e "s2" fala
 * `delta epsilon zeta.` (segundos 0–1.5 e 5–6.5 da fonte). Fps fracionário e
 * quadro 1920×1080 para a prova do formato.
 */
async function montar(dir: string): Promise<void> {
  const p = await loadProject(dir);
  const fonte = fixtureAssembly().sources[0]!;
  p.assembly = fixtureAssembly();
  p.assembly.fps = { num: 30000, den: 1001 };
  p.assembly.width = 1920;
  p.assembly.height = 1080;
  p.assembly.sources = [{ ...fonte, durationSeconds: 30 }];
  p.assembly.tracks.forEach((track) => { track.clips = []; });
  const words: Word[] = [
    palavra(0, 0, "alfa"), palavra(1, 0.4, "beta"), palavra(2, 0.8, "gama."),
    palavra(3, 5, "delta"), palavra(4, 5.4, "epsilon"), palavra(5, 5.8, "zeta."),
  ];
  p.analyses = [{
    sourceId: "a", key: "k", status: "ready",
    speech: [
      { id: "a:s1", sourceId: "a", start: 0, end: 1.5, text: "alfa beta gama." },
      { id: "a:s2", sourceId: "a", start: 5, end: 6.5, text: "delta epsilon zeta." },
    ],
    visual: [], words, wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  }];
  p.scenes = validateProposal({
    id: "p", baseRevision: p.revision, changedSceneIds: ["s1", "s2"],
    scenes: [{ id: "s1", speechIds: ["a:s1"] }, { id: "s2", speechIds: ["a:s2"] }],
  }, p).scenes;
  p.assembly = { ...compileScenes(p, p.scenes), revision: p.revision };
  await saveProject(dir, p.revision, () => p);
}

const json = async (base: string, rev: number): Promise<{ status: number; body: Json & { error?: string } }> => {
  const res = await fetch(`${base}/project/subtitles/${rev}/json`);
  return { status: res.status, body: await res.json() as Json & { error?: string } };
};

const texto = async (base: string, rev: number, formato: "vtt" | "srt") => {
  const res = await fetch(`${base}/project/subtitles/${rev}/${formato}`);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

const textos = (cues: Cue[]) => cues.map((cue) => cue.text).join(" | ");

async function editar(base: string, baseRevision: number, action: unknown): Promise<number> {
  const res = await fetch(`${base}/project/edit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision, action }),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { project: Project }).project.revision;
}

/** Grava a prévia da revisão atual como o fluxo real: sha da montagem guardada. */
async function gravarPrevia(dir: string): Promise<number> {
  const p = await loadProject(dir);
  const assemblySha256 = createHash("sha256").update(JSON.stringify(p.assembly)).digest("hex");
  await saveProject(dir, p.revision, (cur) => ({
    ...cur,
    previewRevision: cur.revision,
    previewArtifact: { revision: cur.revision, assemblySha256, relativePath: `rev-${cur.revision}/x.mp4`, sha256: "0".repeat(64) },
  }));
  return p.revision;
}

it("a rota entrega o mesmo texto que a exportação grava (subtitleRecord), o json traz os mesmos cues", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const projeto = await loadProject(dir);
  // A exportação grava exatamente subtitleRecord(project): vtt, srt e o registro do manifest.
  const { legendas, subtitles } = subtitleRecord(projeto);
  expect(subtitles).not.toBeNull();
  expect(legendas.status).toBe("pronto");

  const vtt = await texto(base, projeto.revision, "vtt");
  const srt = await texto(base, projeto.revision, "srt");
  expect(vtt.status).toBe(200);
  expect(Buffer.from(vtt.text)).toEqual(Buffer.from(subtitles!.vtt));
  expect(Buffer.from(srt.text)).toEqual(Buffer.from(subtitles!.srt));
  expect(vtt.headers.get("cache-control")).toBe("no-store");
  expect(srt.headers.get("cache-control")).toBe("no-store");
  expect(vtt.headers.get("content-type")).toContain("text/vtt");
  expect(srt.headers.get("content-type")).toContain("application/x-subrip");

  const resposta = await json(base, projeto.revision);
  expect(resposta.status).toBe(200);
  expect(resposta.body.origem).toBe("atual");
  expect(resposta.body.cues).toEqual(subtitles!.cues);
  expect(resposta.body.legendas).toEqual(legendas);
  // O manifest guarda o sha dos arquivos que a rota serve.
  expect(createHash("sha256").update(vtt.text, "utf8").digest("hex")).toBe(legendas.status === "pronto" ? legendas.vttSha : "");
  expect(createHash("sha256").update(srt.text, "utf8").digest("hex")).toBe(legendas.status === "pronto" ? legendas.srtSha : "");
  expect(textos(resposta.body.cues)).toContain("alfa beta gama.");
});

it("revisão futura, formato inválido e caminho torto dão 404 com motivo", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const futura = await json(base, 99);
  expect(futura.status).toBe(404);
  expect(futura.body.error).toMatch(/v99 ainda não existe/);
  for (const caminho of ["0/txt", "abc/json", "0/json/extra", "0"]) {
    const res = await fetch(`${base}/project/subtitles/${caminho}`);
    expect(res.status, caminho).toBe(404);
  }
});

it("montagem sem fala retida: json 200 indisponível, vtt e srt 404", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const projeto = await loadProject(dir);
  await saveProject(dir, projeto.revision, (cur) => ({ ...cur, scenes: [], assembly: { ...cur.assembly, tracks: cur.assembly.tracks.map((t) => ({ ...t, clips: [] })) } }));
  const vazio = await json(base, projeto.revision);
  expect(vazio.status).toBe(200);
  expect(vazio.body.legendas).toEqual({ status: "indisponivel", motivo: "sem falas retidas na montagem" });
  expect(vazio.body.cues).toEqual([]);
  expect((await texto(base, projeto.revision, "vtt")).status).toBe(404);
  expect((await texto(base, projeto.revision, "srt")).status).toBe(404);
});

it("prévia antiga: a legenda da vN vem da foto (historico) e não é a da vN+1", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const n = await gravarPrevia(dir);
  const antes = await json(base, n);
  const vttAntes = (await texto(base, n, "vtt")).text;
  expect(antes.body.origem).toBe("atual");

  const takeId = (await loadProject(dir)).scenes[0]!.takes[0]!.id;
  const depois = await editar(base, n, { type: "remove", sceneId: "s1", takeId, wordIds: ["w1"] });
  expect(depois).toBe(n + 1);

  const velha = await json(base, n);
  const nova = await json(base, n + 1);
  expect(velha.status).toBe(200);
  expect(velha.body.origem).toBe("historico");
  expect(velha.body.cues).toEqual(antes.body.cues);
  expect((await texto(base, n, "vtt")).text).toBe(vttAntes);
  expect(nova.body.origem).toBe("atual");
  expect(textos(nova.body.cues)).not.toBe(textos(velha.body.cues));
  expect(textos(velha.body.cues)).toContain("beta");
  expect(textos(nova.body.cues)).not.toContain("beta");
});

it("prévia sem foto, com foto apagada ou que não confere com o sha, ou revisão que não é a da prévia: 404 com motivo", async () => {
  // Sem previewArtifact: revisão anterior não tem legenda.
  {
    const { dir, base } = await boot();
    await montar(dir);
    const takeId = (await loadProject(dir)).scenes[0]!.takes[0]!.id;
    await editar(base, 0, { type: "remove", sceneId: "s1", takeId, wordIds: ["w1"] });
    const semPrevia = await json(base, 0);
    expect(semPrevia.status).toBe(404);
    expect(semPrevia.body.error).toMatch(/não é a prévia guardada/);
    await fechar();
  }
  // Foto apagada.
  {
    const { dir, base } = await boot();
    await montar(dir);
    const n = await gravarPrevia(dir);
    const takeId = (await loadProject(dir)).scenes[0]!.takes[0]!.id;
    await editar(base, n, { type: "remove", sceneId: "s1", takeId, wordIds: ["w1"] });
    expect((await json(base, n)).body.origem).toBe("historico");
    await rm(join(dir, "history", `rev-${n}.json`));
    const apagada = await json(base, n);
    expect(apagada.status).toBe(404);
    expect(apagada.body.error).toMatch(/não tem histórico/);
    await fechar();
  }
  // A foto não confere: renomear depois muda o nome da montagem recomposta.
  {
    const { dir, base } = await boot();
    await montar(dir);
    const n = await gravarPrevia(dir);
    const takeId = (await loadProject(dir)).scenes[0]!.takes[0]!.id;
    const rev1 = await editar(base, n, { type: "remove", sceneId: "s1", takeId, wordIds: ["w1"] });
    const renomear = await fetch(`${base}/project/rename`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: rev1, nome: "outro nome" }),
    });
    expect(renomear.status).toBe(200);
    const desigual = await json(base, n);
    expect(desigual.status).toBe(404);
    expect(desigual.body.error).toMatch(/não pôde ser recomposta igual/);
    await fechar();
  }
  // Revisão com foto, mas que não é a da prévia: a prévia continua válida.
  {
    const { dir, base } = await boot();
    await montar(dir);
    const n = await gravarPrevia(dir);
    const takeId = (await loadProject(dir)).scenes[0]!.takes[0]!.id;
    const rev1 = await editar(base, n, { type: "remove", sceneId: "s1", takeId, wordIds: ["w1"] });
    await editar(base, rev1, { type: "remove", sceneId: "s1", takeId, wordIds: ["w2"] });
    const outra = await json(base, rev1);
    expect(outra.status).toBe(404);
    expect(outra.body.error).toMatch(/não é a prévia guardada/);
    expect((await json(base, n)).body.origem).toBe("historico");
  }
});

it("corte (remove) tira a palavra do cue", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const antes = await json(base, 0);
  expect(textos(antes.body.cues)).toContain("beta");
  const takeId = (await loadProject(dir)).scenes[0]!.takes[0]!.id;
  const rev = await editar(base, 0, { type: "remove", sceneId: "s1", takeId, wordIds: ["w1"] });
  const depois = await json(base, rev);
  expect(textos(depois.body.cues)).not.toContain("beta");
  expect(textos(depois.body.cues)).toContain("alfa");
  const vtt = await texto(base, rev, "vtt");
  expect(vtt.text).not.toContain("beta");
  expect((await texto(base, rev, "srt")).text).not.toContain("beta");
});

it("correção alinhada muda o texto do cue na mesma revisão", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const antes = await json(base, 0);
  expect(textos(antes.body.cues)).toContain("beta");
  // Como o servidor: a edição registra a correção pendente e o alinhamento a publica sem nova revisão.
  await saveProject(dir, 0, (cur) => {
    const pendente = applyEdit(cur, { type: "correct", sourceId: "a", start: 0.4, end: 0.7, text: "BETA CORRIGIDO" });
    const id = pendente.corrections.find((item) => !cur.corrections.some((old) => old.id === item.id))!.id;
    return settleCorrection(pendente, id, { words: [{ text: "BETA CORRIGIDO", start: 0.4, end: 0.7, confidence: 0.9 }] });
  });
  const projeto = await loadProject(dir);
  const depois = await json(base, projeto.revision);
  expect(depois.status).toBe(200);
  expect(textos(depois.body.cues)).toContain("BETA CORRIGIDO");
  expect(textos(depois.body.cues)).not.toContain(" beta ");
  expect(depois.body.cues).toEqual(subtitleRecord(projeto).subtitles!.cues);
  expect(depois.body.legendas.vttSha).not.toBe(antes.body.legendas.vttSha);
});

it("reordenar cenas (move-scene) muda a ordem dos cues", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const antes = await json(base, 0);
  const ordem = (cues: Cue[]) => textos(cues).indexOf("alfa") < textos(cues).indexOf("delta");
  expect(ordem(antes.body.cues)).toBe(true);
  const rev = await editar(base, 0, { type: "move-scene", sceneId: "s2", direction: "up" });
  const depois = await json(base, rev);
  expect(ordem(depois.body.cues)).toBe(false);
  expect(textos(depois.body.cues)).toContain("delta");
  expect(textos(depois.body.cues).indexOf("delta")).toBeLessThan(textos(depois.body.cues).indexOf("alfa"));
  // Os cues seguem em ordem de tempo.
  expect(depois.body.cues.map((cue) => cue.startMs)).toEqual(depois.body.cues.map((cue) => cue.startMs).sort((a, b) => a - b));
});

it("POST project/settings com o pedido de proporção do studio mantém o fps da montagem", async () => {
  const { dir, base } = await boot();
  await montar(dir);
  const projeto = await loadProject(dir);
  expect(projeto.assembly.fps).toEqual({ num: 30000, den: 1001 });
  const pedido = pedidoDeFormato("9:16", projeto);
  expect(pedido.body).toBeDefined();
  expect(pedido.body).toMatchObject({ baseRevision: projeto.revision, width: 1080, height: 1920, fps: { num: 30000, den: 1001 } });
  const res = await fetch(`${base}/project/settings`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pedido.body),
  });
  expect(res.status).toBe(200);
  const depois = (await res.json() as { project: Project }).project;
  expect(depois.assembly).toMatchObject({ width: 1080, height: 1920, fps: { num: 30000, den: 1001 } });
  expect((await loadProject(dir)).assembly.fps).toEqual({ num: 30000, den: 1001 });
});
