import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "../server.ts";
import { compileScenes } from "./scenes.ts";
import { buildSubtitles, formatSrt, formatVtt } from "./subtitles.ts";
import type { Analysis, Project, Rate, Scene, Source, Span, Word } from "./types.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function source(id: string, durationSeconds: number): Source {
  return {
    id, path: `/midia/${id}.mp4`, sha256: "0123456789abcdef".repeat(4), durationSeconds,
    hasVideo: true, hasAudio: true, fps: { num: 25, den: 1 }, width: 1280, height: 720,
    role: "speech", included: true, name: `${id}.mp4`,
  };
}

function word(sourceId: string, i: number, start: number, end: number, text: string): Word {
  return { id: `${sourceId}:w${i}`, sourceId, start, end, text, confidence: 0.9 };
}

function analysis(sourceId: string, words: Word[], speech: Span[] = [], wordsStatus: Analysis["wordsStatus"] = "ready"): Analysis {
  return { sourceId, key: "k", status: "ready", wordsStatus, visual: [], speech, words,
    visualCoverage: { requested: [], returned: [], missing: [] } };
}

function take(id: string, sourceId: string, start: number, end: number, removed: { start: number; end: number }[] = []) {
  return { id, sourceId, speechId: null, start, end, removed, protected: [] };
}

function scene(id: string, takes: Scene["takes"]): Scene {
  return { id, objective: "cena", rationale: "", speechIds: [], takes, visualEvidenceIds: [], support: [], gaps: [] };
}

function project(fps: Rate, sources: Source[], scenes: Scene[], analyses: Analysis[]): Project {
  const stub: Project = {
    version: 2, id: "legendas", revision: 1, input: { kind: "brief", text: "tema", targetSeconds: 0 },
    assembly: { version: 1, revision: 1, name: "legendas", fps, width: 1280, height: 720, sources, tracks: [] },
    scenes, analyses, proposal: null, previewRevision: null, finalApprovedRevision: null,
    corrections: [], preparation: null, permissions: { model: false, visual: false }, previewArtifact: null,
  };
  return { ...stub, assembly: compileScenes(stub, scenes) };
}

it("ordem cena->take em multi-fonte: take posterior na fonte não passa na frente", () => {
  const fps = { num: 25, den: 1 };
  // A cena 1 usa a fonte A no fim (5-7s); a cena 2 usa a fonte B no começo
  // (0-2s). Ordenar por tempo de fonte (erro do buildSrt) inverteria as falas.
  const p = project(fps, [source("a", 10), source("b", 10)],
    [scene("s1", [take("t1", "a", 5, 7)]), scene("s2", [take("t2", "b", 0, 2)])],
    [analysis("a", [word("a", 1, 5.0, 5.4, "ola"), word("a", 2, 5.6, 6.0, "mundo")]),
     analysis("b", [word("b", 1, 0.2, 0.6, "bom"), word("b", 2, 0.8, 1.2, "dia")])]);
  const subs = buildSubtitles(p);
  expect(subs).not.toBeNull();
  expect(subs!.cues.map((c) => c.text)).toEqual(["ola mundo", "bom dia"]);
  expect(subs!.cues[0]).toMatchObject({ startMs: 0, endMs: 1000 });
  // A cena 2 começa no frame 50 (2000ms); a palavra em 0.2s da fonte B cai
  // em 2200ms da timeline — a ordem é da cena, o offset é da timeline.
  expect(subs!.cues[1]).toMatchObject({ startMs: 2200, endMs: 3200 });
});

it("fala reutilizada em cenas distintas recebe a posição de timeline da cena certa", () => {
  const fps = { num: 25, den: 1 };
  // A mesma passagem da fonte A (0-2s) é usada na cena 1 e repetida na cena 2.
  const p = project(fps, [source("a", 10)],
    [scene("s1", [take("t1", "a", 0, 2)]), scene("s2", [take("t2", "a", 0, 2)])],
    [analysis("a", [word("a", 1, 0.2, 0.8, "repetida")])]);
  const subs = buildSubtitles(p);
  expect(subs).not.toBeNull();
  expect(subs!.cues).toHaveLength(2);
  expect(subs!.cues[0]).toMatchObject({ text: "repetida", startMs: 200, endMs: 800 });
  // A segunda ocorrência deve estar na timeline da cena 2 (2000ms + 200ms = 2200ms),
  // e não herdar a posição do clipe da cena 1.
  expect(subs!.cues[1]).toMatchObject({ text: "repetida", startMs: 2200, endMs: 2800 });
});

it("offsets exatos em 29.97 (30000/1001), sem drift entre cenas", () => {
  const fps = { num: 30000, den: 1001 };
  const p = project(fps, [source("a", 30)],
    [scene("s1", [take("t1", "a", 10, 12)]), scene("s2", [take("t2", "a", 20, 22)])],
    [analysis("a", [word("a", 1, 10.5, 10.9, "meio"), word("a", 2, 11.0, 11.4, "fim"),
      word("a", 3, 21.0, 21.4, "depois")])]);
  const subs = buildSubtitles(p);
  expect(subs).not.toBeNull();
  // first=floor(10*30000/1001)=299 → sourceStart=299*1001/30000=9.9766333s.
  expect(subs!.cues[0]).toMatchObject({ startMs: 523, endMs: 1423 });
  // Segunda cena começa no frame 61 (61*1001/30000=2.0353667s); a palavra em
  // 21.0s (fonte requantizada em 19.9866333s) cai em 3049ms, não em 3000ms.
  expect(subs!.cues[1]).toMatchObject({ startMs: 3049, endMs: 3449 });
});

it("palavras em trechos removidos e cacoetes não legendam", () => {
  const fps = { num: 25, den: 1 };
  // Retidos [0,2) e [8,10): na timeline viram [0,2s) e [2s,4s); o gap entre
  // as falas (600→2200ms) quebra o cue.
  const p = project(fps, [source("a", 12)], [scene("s1", [take("t1", "a", 0, 10, [{ start: 2, end: 8 }])])],
    [analysis("a", [word("a", 1, 0.2, 0.6, "fica"), word("a", 2, 4.0, 4.5, "sai"), word("a", 3, 8.2, 8.6, "volta")])]);
  const subs = buildSubtitles(p);
  expect(subs!.cues.map((c) => c.text)).toEqual(["fica", "volta"]);
  expect(subs!.cues[1]).toMatchObject({ startMs: 2200 });
});

it("sem palavras/sem falas retorna null sem erro", () => {
  const fps = { num: 25, den: 1 };
  expect(buildSubtitles(project(fps, [source("a", 10)],
    [scene("s1", [take("t1", "a", 0, 2)])], []))).toBeNull();
  expect(buildSubtitles(project(fps, [source("a", 10)],
    [scene("s1", [take("t1", "a", 0, 2, [{ start: 0, end: 2 }])])],
    [analysis("a", [word("a", 1, 0.2, 0.6, "tudo")])]))).toBeNull();
  expect(buildSubtitles(project(fps, [source("a", 10)],
    [scene("s1", [take("t1", "a", 0, 2)])],
    [analysis("a", [], [], "missing")]))).toBeNull();
});

it("wordsStatus != ready usa spans de fala como fallback", () => {
  const fps = { num: 25, den: 1 };
  const p = project(fps, [source("a", 10)], [scene("s1", [take("t1", "a", 4, 8)])],
    [analysis("a", [], [{ id: "a:u1", sourceId: "a", start: 4.5, end: 6.5, text: "fala sem palavras" }], "missing")]);
  const subs = buildSubtitles(p);
  expect(subs!.cues).toMatchObject([{ startMs: 500, endMs: 2500, text: "fala sem palavras" }]);
});

it("correção aligned entra na legenda com o texto corrigido", () => {
  const fps = { num: 25, den: 1 };
  const p = project(fps, [source("a", 10)], [scene("s1", [take("t1", "a", 0, 2)])],
    [analysis("a", [word("a", 1, 0.2, 0.8, "errado")])]);
  p.corrections = [{ id: "c1", sourceId: "a", start: 0.2, end: 0.8, text: "certo", status: "aligned",
    words: [{ id: "c1w", sourceId: "a", start: 0.2, end: 0.8, text: "certo", confidence: 1 }] }];
  expect(buildSubtitles(p)!.cues.map((c) => c.text)).toEqual(["certo"]);
});

it("quebra de frase e formato VTT/SRT", () => {
  const fps = { num: 25, den: 1 };
  const p = project(fps, [source("a", 10)], [scene("s1", [take("t1", "a", 0, 5)])],
    [analysis("a", [word("a", 1, 0.0, 0.5, "Oi."), word("a", 2, 1.0, 1.5, "Tudo"), word("a", 3, 1.6, 2.0, "bem?")])]);
  const subs = buildSubtitles(p)!;
  expect(subs.cues.map((c) => c.text)).toEqual(["Oi.", "Tudo bem?"]);
  expect(subs.vtt).toMatch(/^WEBVTT\n\n00:00:00\.000 --> 00:00:00\.500\nOi\.\n/);
  expect(subs.srt).toContain("1\n00:00:00,000 --> 00:00:00,500\nOi.\n");
  expect(subs.srt).toContain("\n2\n00:00:01,000 --> 00:00:02,000\nTudo bem?\n");
  expect(formatVtt([])).toBe("WEBVTT\n\n");
  expect(formatSrt([])).toBe("");
});

it("GET /project/output serve legendas.vtt e legendas.srt, 404 quando ausentes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legendas-output-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const app = await startApp({ projectDir: dir, port: 0, env: {} });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  await mkdir(join(dir, "exports", "0"), { recursive: true });
  await writeFile(join(dir, "exports", "0", "legendas.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOi\n", "utf8");
  await writeFile(join(dir, "exports", "0", "legendas.srt"), "1\n00:00:00,000 --> 00:00:01,000\nOi\n", "utf8");
  const vtt = await fetch(`${base}/project/output/0/vtt`);
  expect(vtt.status).toBe(200);
  expect(vtt.headers.get("content-type")).toContain("text/vtt");
  expect(await vtt.text()).toContain("WEBVTT");
  const srt = await fetch(`${base}/project/output/0/srt`);
  expect(srt.status).toBe(200);
  expect(srt.headers.get("content-type")).toContain("application/x-subrip");
  expect(await srt.text()).toContain("00:00:00,000");
  expect((await fetch(`${base}/project/output/0/mp4`)).status).toBe(404);
  // Kind desconhecido: 404 explícito, nunca EISDIR/500 no diretório.
  expect((await fetch(`${base}/project/output/0/bogus`)).status).toBe(404);
});
