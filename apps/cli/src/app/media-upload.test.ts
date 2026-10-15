import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { startApp, type AppHandle } from "./server.ts";
import { createMediaRuntime, writeBufferFully } from "./media-runtime.ts";

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

it("publica no GET quando o processo caiu depois de gravar o estado final", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-recover-final-"));
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const base = await boot(root);
  const upload = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "queda.mp4", tamanho: input.byteLength }),
  })).json() as { id: string };
  await writeFile(join(root, ".tmp", upload.id, "data"), input);
  await writeFile(join(root, ".tmp", upload.id, "state.json"), JSON.stringify({
    nome: "queda.mp4", tamanhoTotal: input.byteLength, recebido: input.byteLength,
    criadoEm: Date.now(), atualizadoEm: Date.now(),
  }));

  const repeatedStart = input.byteLength - 4096;
  const repeated = await fetch(`${base}/api/uploads/${upload.id}`, {
    method: "PATCH", headers: { "Content-Range": range(repeatedStart, input.byteLength - 1, input.byteLength) }, body: input.subarray(repeatedStart),
  });
  expect(repeated.status).toBe(201);
  expect(await repeated.json()).toMatchObject({
    mediaId: createHash("sha256").update(input).digest("hex"),
  });
  const recovered = await fetch(`${base}/api/uploads/${upload.id}`);
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    mediaId: createHash("sha256").update(input).digest("hex"), estado: "ready",
  });
  expect(await (await fetch(`${base}/api/media`)).json()).toHaveLength(1);
});

it("descarta o hash e o parcial quando a gravação do estado falha", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-state-failure-"));
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const sha256 = createHash("sha256").update(input).digest("hex");
  const base = await boot(root);
  const upload = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "falha.mp4", tamanho: input.byteLength, sha256 }),
  })).json() as { id: string; tamanhoParte: number };
  const uploadDir = join(root, ".tmp", upload.id);
  const firstEnd = Math.min(input.byteLength, upload.tamanhoParte) - 1;
  await chmod(uploadDir, 0o555);
  const failed = await fetch(`${base}/api/uploads/${upload.id}`, {
    method: "PATCH", headers: { "Content-Range": range(0, firstEnd, input.byteLength) },
    body: input.subarray(0, firstEnd + 1),
  });
  await chmod(uploadDir, 0o755);
  expect(failed.status).toBe(500);

  let offset = 0;
  let final: Response | undefined;
  while (offset < input.byteLength) {
    const end = Math.min(input.byteLength, offset + upload.tamanhoParte) - 1;
    final = await fetch(`${base}/api/uploads/${upload.id}`, {
      method: "PATCH", headers: { "Content-Range": range(offset, end, input.byteLength) },
      body: input.subarray(offset, end + 1),
    });
    offset = end + 1;
  }
  expect(final!.status).toBe(201);
  expect(await final!.json()).toMatchObject({ mediaId: sha256, deduplicado: false });
});

it("recria o metadado de uma Mídia deduplicada que só tem o arquivo", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-metadata-repair-"));
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const sha256 = createHash("sha256").update(input).digest("hex");
  await mkdir(join(root, "pool"), { recursive: true });
  await writeFile(join(root, "pool", sha256), input);
  const base = await boot(root);
  const response = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "recuperada.mp4", tamanho: input.byteLength, sha256 }),
  });
  expect(response.status).toBe(200);
  const listed = await (await fetch(`${base}/api/media`)).json() as { id: string }[];
  expect(listed.map((item) => item.id)).toEqual([sha256]);
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

it("recusa envio de mídia vazia", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-empty-"));
  const base = await boot(root);
  const response = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "vazia.mp4", tamanho: 0 }),
  });
  expect(response.status).toBe(400);
});

it("guarda a resposta final para uma retomada depois de resposta perdida", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-completion-"));
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const sha256 = createHash("sha256").update(input).digest("hex");
  const base = await boot(root);
  const upload = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "resposta-perdida.mp4", tamanho: input.byteLength }),
  })).json() as { id: string; tamanhoParte: number };
  for (let offset = 0; offset < input.byteLength;) {
    const end = Math.min(input.byteLength, offset + upload.tamanhoParte) - 1;
    await fetch(`${base}/api/uploads/${upload.id}`, {
      method: "PATCH", headers: { "Content-Range": range(offset, end, input.byteLength) },
      body: input.subarray(offset, end + 1),
    });
    offset = end + 1;
  }
  const state = await fetch(`${base}/api/uploads/${upload.id}`);
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ mediaId: sha256, estado: "ready" });
});

it("reusa o runtime de Mídias ao abrir um Projeto novo e reconstitui hash alterado em disco", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-shared-runtime-"));
  const projectDir = join(root, "project");
  const mediaRoot = join(root, "media");
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const sha256 = createHash("sha256").update(input).digest("hex");
  await mkdir(projectDir, { recursive: true });
  const app = await startApp({
    projectDir, port: 0, executor,
    env: { DECUPA_MEDIA_ROOT: mediaRoot, DECUPA_UPLOAD_PART_BYTES: "20000" },
  });
  apps.push(app);
  const base = `http://127.0.0.1:${app.port}`;
  const upload = await (await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "compartilhada.mp4", tamanho: input.byteLength }),
  })).json() as { id: string; tamanhoParte: number };
  const firstEnd = upload.tamanhoParte - 1;
  expect((await fetch(`${base}/api/uploads/${upload.id}`, {
    method: "PATCH", headers: { "Content-Range": range(0, firstEnd, input.byteLength) }, body: input.subarray(0, firstEnd + 1),
  })).status).toBe(200);

  const created = await fetch(`${base}/project/new`, { method: "POST" });
  expect(created.status).toBe(201);
  const child = await created.json() as { url: string };
  const secondEnd = Math.min(input.byteLength, upload.tamanhoParte * 2) - 1;
  expect((await fetch(`${child.url}api/uploads/${upload.id}`, {
    method: "PATCH", headers: { "Content-Range": range(upload.tamanhoParte, secondEnd, input.byteLength) },
    body: input.subarray(upload.tamanhoParte, secondEnd + 1),
  })).status).toBe(200);

  const finalStart = secondEnd + 1;
  const final = await fetch(`${base}/api/uploads/${upload.id}`, {
    method: "PATCH", headers: { "Content-Range": range(finalStart, input.byteLength - 1, input.byteLength) },
    body: input.subarray(finalStart),
  });
  expect(final.status).toBe(201);
  expect(await final.json()).toMatchObject({ mediaId: sha256, deduplicado: false });
});

it("repete uma escrita curta até consumir toda a parte", async () => {
  const calls: Array<{ offset: number; length: number; position: number }> = [];
  const file = {
    async write(buffer: Uint8Array, offset: number, length: number, position: number) {
      calls.push({ offset, length, position });
      return { bytesWritten: Math.min(2, length) };
    },
  };
  await writeBufferFully(file, Buffer.from("abcde"), 10);
  expect(calls.map(({ length, position }) => ({ length, position }))).toEqual([
    { length: 5, position: 10 }, { length: 3, position: 12 }, { length: 1, position: 14 },
  ]);
});

it("registra erro da limpeza periódica sem rejeição não tratada", async () => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "media-cleanup-error-"));
  const errors: unknown[] = [];
  const runtime = await createMediaRuntime({
    root, env: { DECUPA_UPLOAD_TTL_HOURS: "0" },
    log: (_message, error) => errors.push(error),
    cleanupIntervalMs: 1,
  });
  await rm(join(root, ".tmp"), { recursive: true, force: true });
  await vi.advanceTimersByTimeAsync(1);
  // O timer dispara com o relógio falso, mas o erro vem de um `readdir` real:
  // ele chega pelo disco, não pela fila de microtarefas. Espera de verdade.
  vi.useRealTimers();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  await runtime.close();
});

// Dois processos `decupa` com o mesmo DECUPA_MEDIA_ROOT: cada um tem o próprio
// hash em memória. Se A reaproveitasse o seu depois de B gravar uma parte, o
// tamanho em disco bateria com o estado e a Mídia seria publicada com um id
// que não é o SHA-256 do arquivo.
it("dois runtimes na mesma raiz alternando partes publicam o SHA-256 real", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-two-runtimes-"));
  const clip = await readFile(join(FIXTURES, "clip.mp4"));
  const expected = createHash("sha256").update(clip).digest("hex");
  const { createServer } = await import("node:http");
  const servers: Array<{ base: string; close: () => Promise<void> }> = [];
  for (let i = 0; i < 2; i += 1) {
    const runtime = await createMediaRuntime({ root, env: { DECUPA_UPLOAD_PART_BYTES: "16384" } });
    const server = createServer((req, res) => { void runtime.handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    servers.push({ base: `http://127.0.0.1:${port}`, close: async () => {
      await runtime.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    } });
  }
  const [a, b] = servers as [typeof servers[0], typeof servers[0]];
  try {
    const created = await (await fetch(`${a.base}/api/uploads`, { method: "POST", body: JSON.stringify({ nome: "x.mp4", tamanho: clip.length }) })).json() as { id: string };
    const part = (base: string, start: number, end: number) => fetch(`${base}/api/uploads/${created.id}`, {
      method: "PATCH", headers: { "content-range": range(start, end, clip.length) }, body: clip.subarray(start, end + 1),
    });
    expect((await part(a.base, 0, 16383)).status).toBe(200);
    expect((await part(b.base, 16384, 32767)).status).toBe(200);
    const last = await part(a.base, 32768, clip.length - 1);
    expect(last.status).toBe(201);
    expect((await last.json() as { mediaId: string }).mediaId).toBe(expected);
  } finally {
    for (const server of servers) await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
