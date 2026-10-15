import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { startApp, type AppHandle } from "./server.ts";

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };
const apps: AppHandle[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(mediaRoot: string, extraEnv: Record<string, string> = {}, now?: () => number) {
  const work = join(mediaRoot, "work");
  await mkdir(work, { recursive: true });
  const app = await startApp({
    input: join(work, "source.mp4"), port: 0, autoStart: false, executor,
    now,
    env: { DECUPA_MEDIA_ROOT: mediaRoot, DECUPA_UPLOAD_PART_BYTES: "4096", ...extraEnv },
  });
  apps.push(app);
  return `http://127.0.0.1:${app.port}`;
}

function range(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}

it("envia uma mídia em partes, informa o offset e publica no acervo", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-upload-"));
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const sha256 = createHash("sha256").update(input).digest("hex");
  const base = await boot(root);
  const created = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "aula.mp4", tamanho: input.byteLength }),
  });
  expect(created.status).toBe(201);
  const upload = await created.json() as { id: string; offset: number; tamanhoParte: number };
  expect(upload.offset).toBe(0);
  expect(upload.tamanhoParte).toBe(4096);

  let offset = 0;
  let completed: Response | undefined;
  while (offset < input.byteLength) {
    const end = Math.min(input.byteLength, offset + upload.tamanhoParte) - 1;
    completed = await fetch(`${base}/api/uploads/${upload.id}`, {
      method: "PATCH", headers: { "Content-Range": range(offset, end, input.byteLength) },
      body: input.subarray(offset, end + 1),
    });
    expect(completed.status).toBe(end + 1 === input.byteLength ? 201 : 200);
    offset = end + 1;
  }
  expect(await completed!.json()).toMatchObject({ mediaId: sha256, deduplicado: false });
  const media = await (await fetch(`${base}/api/media`)).json() as { id: string; nome: string; tamanho: number; duracao: number }[];
  expect(media).toEqual([expect.objectContaining({ id: sha256, nome: "aula.mp4", tamanho: input.byteLength })]);
  expect(media[0]!.duracao).toBeGreaterThan(0);
});

it("retoma depois de reiniciar, aceita parte repetida e recusa salto com o offset atual", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-resume-"));
  const input = await readFile(join(FIXTURES, "tone-gap.wav"));
  const base = await boot(root);
  const created = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "fala.wav", tamanho: input.byteLength }),
  })).json() as { id: string; tamanhoParte: number };
  const part = input.subarray(0, created.tamanhoParte);
  const first = await fetch(`${base}/api/uploads/${created.id}`, {
    method: "PATCH", headers: { "Content-Range": range(0, part.length - 1, input.byteLength) }, body: part,
  });
  expect(first.status).toBe(200);
  const repeated = await fetch(`${base}/api/uploads/${created.id}`, {
    method: "PATCH", headers: { "Content-Range": range(0, part.length - 1, input.byteLength) }, body: part,
  });
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual({ offset: part.length });
  const skipped = await fetch(`${base}/api/uploads/${created.id}`, {
    method: "PATCH", headers: { "Content-Range": range(part.length + 1, part.length + 2, input.byteLength) }, body: input.subarray(part.length + 1, part.length + 3),
  });
  expect(skipped.status).toBe(409);
  expect(await skipped.json()).toEqual({ offset: part.length });
  const state = await (await fetch(`${base}/api/uploads/${created.id}`)).json();
  expect(state).toMatchObject({ offset: part.length, tamanhoTotal: input.byteLength, estado: "uploading" });

  await apps.shift()!.close();
  const resumedBase = await boot(root);
  let offset = part.length;
  while (offset < input.byteLength) {
    const end = Math.min(input.byteLength, offset + created.tamanhoParte) - 1;
    const response = await fetch(`${resumedBase}/api/uploads/${created.id}`, {
      method: "PATCH", headers: { "Content-Range": range(offset, end, input.byteLength) }, body: input.subarray(offset, end + 1),
    });
    expect(response.status).toBe(end + 1 === input.byteLength ? 201 : 200);
    offset = end + 1;
  }
});

it("deduplica pelo hash já conhecido e rejeita mídia ilegível apagando o temporário", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-dedupe-"));
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const sha256 = createHash("sha256").update(input).digest("hex");
  const base = await boot(root);
  const upload = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "primeiro.mp4", tamanho: input.byteLength }),
  })).json() as { id: string; tamanhoParte: number };
  for (let offset = 0; offset < input.byteLength;) {
    const end = Math.min(input.byteLength, offset + upload.tamanhoParte) - 1;
    await fetch(`${base}/api/uploads/${upload.id}`, { method: "PATCH", headers: { "Content-Range": range(offset, end, input.byteLength) }, body: input.subarray(offset, end + 1) });
    offset = end + 1;
  }
  const known = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "outro-nome.mp4", tamanho: input.byteLength, sha256 }),
  });
  expect(known.status).toBe(200);
  expect(await known.json()).toEqual({ mediaId: sha256, deduplicado: true });

  const repeated = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "terceiro-nome.mp4", tamanho: input.byteLength }),
  })).json() as { id: string; tamanhoParte: number };
  let final: Response | undefined;
  for (let offset = 0; offset < input.byteLength;) {
    const end = Math.min(input.byteLength, offset + repeated.tamanhoParte) - 1;
    final = await fetch(`${base}/api/uploads/${repeated.id}`, {
      method: "PATCH", headers: { "Content-Range": range(offset, end, input.byteLength) }, body: input.subarray(offset, end + 1),
    });
    offset = end + 1;
  }
  expect(final!.status).toBe(201);
  expect(await final!.json()).toEqual({ mediaId: sha256, deduplicado: true });

  const bad = Buffer.from("não é vídeo");
  const badUpload = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "quebrado.bin", tamanho: bad.byteLength }),
  })).json() as { id: string };
  const invalid = await fetch(`${base}/api/uploads/${badUpload.id}`, {
    method: "PATCH", headers: { "Content-Range": range(0, bad.byteLength - 1, bad.byteLength) }, body: bad,
  });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: expect.stringMatching(/mídia|ffprobe/i) });
  expect((await readdir(join(root, ".tmp"))).includes(badUpload.id)).toBe(false);
});

it("apaga envios inativos na subida e mantém os ativos", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-ttl-"));
  const now = 2_000_000_000_000;
  const old = join(root, ".tmp", "00000000-0000-4000-8000-000000000001");
  const fresh = join(root, ".tmp", "00000000-0000-4000-8000-000000000002");
  await mkdir(old, { recursive: true });
  await mkdir(fresh, { recursive: true });
  await writeFile(join(old, "state.json"), JSON.stringify({ nome: "a", tamanhoTotal: 1, recebido: 0, criadoEm: now - 25 * 60 * 60 * 1000, atualizadoEm: now - 25 * 60 * 60 * 1000 }));
  await writeFile(join(fresh, "state.json"), JSON.stringify({ nome: "b", tamanhoTotal: 1, recebido: 0, criadoEm: now, atualizadoEm: now }));
  const base = await boot(root, { DECUPA_UPLOAD_TTL_HOURS: "24" }, () => now);
  expect((await readdir(join(root, ".tmp"))).sort()).toEqual(["00000000-0000-4000-8000-000000000002"]);
  expect((await stat(join(root, "pool"))).isDirectory()).toBe(true);
  expect((await fetch(`${base}/api/uploads/00000000-0000-4000-8000-000000000002`)).status).toBe(200);
});

it("recusa mídia acima do máximo configurado", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-limit-"));
  const base = await boot(root, { DECUPA_UPLOAD_MAX_GB: "0.000001" });
  const response = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "grande.mp4", tamanho: 100_000 }),
  });
  expect(response.status).toBe(413);
});
