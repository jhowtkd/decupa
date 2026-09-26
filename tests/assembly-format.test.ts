/**
 * Formato original (#67): o projeto novo adota o formato de exibição da
 * primeira fonte de fala com vídeo — rotação e dimensões de exibição
 * contam. A escolha fica visível (canvasSourceId/canvasManual) e travada:
 * materiais mistos depois não redimensionam silenciosamente, e a mudança
 * só acontece por /project/settings, que gera revisão e invalida a prévia.
 */
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "../apps/cli/src/app/server.ts";
import { FIXTURES } from "./fixtures/global-setup.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

type AssemblyView = {
  width: number; height: number; fps: { num: number; den: number };
  canvasSourceId?: string | null; canvasManual?: boolean;
  sources: { id: string; name: string; rotation?: number | null; hasVideo: boolean }[];
};

type ProjectView = {
  revision: number;
  previewRevision: number | null;
  finalApprovedRevision: number | null;
  assembly: AssemblyView;
};

async function getProject(base: string): Promise<ProjectView> {
  const res = await fetch(`${base}/project`);
  const data = await res.json() as { project: ProjectView };
  return data.project;
}

async function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("fonte de fala rotacionada define o formato de exibição do projeto novo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-format-"));
  const rot = join(dir, "rot.mov");
  await copyFile(join(FIXTURES, "rotated-90.mov"), rot);
  const app = await startApp({
    projectDir: dir, port: 0,
    selectFn: async () => ({ paths: [rot] }),
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const empty = await getProject(base);
  expect(empty.assembly.width).toBe(320);
  const sel = await post(base, "/project/select", { baseRevision: empty.revision });
  expect(sel.status).toBe(200);

  const p = await getProject(base);
  const source = p.assembly.sources[0]!;
  expect(source.rotation).toBe(90);
  expect(p.assembly.width).toBe(360);
  expect(p.assembly.height).toBe(640);
  expect(p.assembly.fps).toEqual({ num: 25, den: 1 });
  expect(p.assembly.canvasSourceId).toBe(source.id);
  expect(p.assembly.canvasManual).toBe(false);
});

it("materiais mistos não redimensionam depois; troca de formato é manual e gera revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-format-mixed-"));
  const vert = join(dir, "fala-vertical.mov");
  const clip = join(dir, "apoio.mp4");
  const audio = join(dir, "nar.wav");
  await copyFile(join(FIXTURES, "vertical-360x640.mov"), vert);
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  await copyFile(join(FIXTURES, "tone-gap.wav"), audio);
  let batch = true;
  const app = await startApp({
    projectDir: dir, port: 0,
    selectFn: async () => ({ paths: batch ? [vert, clip] : [audio] }),
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const empty = await getProject(base);
  expect((await post(base, "/project/select", { baseRevision: empty.revision })).status).toBe(200);
  let p = await getProject(base);
  expect(p.assembly.sources).toHaveLength(2);
  // Lote [vertical, apoio]: a de fala com vídeo é a vertical; clip veio
  // junto mas não deslocou a escolha.
  const vertId = p.assembly.sources.find((s) => s.name === "fala-vertical.mov")!.id;
  expect(p.assembly.width).toBe(360);
  expect(p.assembly.height).toBe(640);
  expect(p.assembly.canvasSourceId).toBe(vertId);
  const formatoRev = p.revision;

  // Mais mídia depois: nem apoio horizontal nem áudio mudam o formato.
  batch = false;
  expect((await post(base, "/project/select", { baseRevision: p.revision })).status).toBe(200);
  p = await getProject(base);
  expect(p.assembly.sources).toHaveLength(3);
  expect(p.assembly.width).toBe(360);
  expect(p.assembly.height).toBe(640);

  // Formato manual: revisão nova, prévia e aprovação invalidadas (bump).
  const settings = await post(base, "/project/settings", {
    baseRevision: p.revision,
    width: 1280, height: 720, fps: { num: 30, den: 1 },
  });
  expect(settings.status).toBe(200);
  p = await getProject(base);
  expect(p.revision).toBeGreaterThan(formatoRev);
  expect(p.assembly.width).toBe(1280);
  expect(p.assembly.height).toBe(720);
  expect(p.assembly.fps).toEqual({ num: 30, den: 1 });
  expect(p.assembly.canvasManual).toBe(true);
  expect(p.assembly.canvasSourceId).toBeNull();
  expect(p.previewRevision).toBeNull();
  expect(p.finalApprovedRevision).toBeNull();

  // "Usar formato de" outra fonte: canvas vira o dela e a escolha é manual.
  const bySource = await post(base, "/project/settings", {
    baseRevision: p.revision,
    sourceId: vertId,
  });
  expect(bySource.status).toBe(200);
  p = await getProject(base);
  expect(p.assembly.width).toBe(360);
  expect(p.assembly.height).toBe(640);
  expect(p.assembly.canvasSourceId).toBe(vertId);
  expect(p.assembly.canvasManual).toBe(true);

  // Nem a nova fonte de fala destrava uma escolha manual.
  batch = false;
  const before = p.revision;
  expect((await post(base, "/project/select", { baseRevision: before })).status).toBe(200);
  p = await getProject(base);
  expect(p.assembly.width).toBe(360);
  expect(p.assembly.canvasSourceId).toBe(vertId);

  // Recusas: fonte sem vídeo, dimensão ímpar e revisão desatualizada.
  const audioId = p.assembly.sources.find((s) => !s.hasVideo)!.id;
  expect((await post(base, "/project/settings", {
    baseRevision: p.revision, sourceId: audioId,
  })).status).toBe(400);
  expect((await post(base, "/project/settings", {
    baseRevision: p.revision, width: 321, height: 240, fps: { num: 25, den: 1 },
  })).status).toBe(400);
  expect((await post(base, "/project/settings", {
    baseRevision: 0, width: 640, height: 480, fps: { num: 25, den: 1 },
  })).status).toBe(409);
});
