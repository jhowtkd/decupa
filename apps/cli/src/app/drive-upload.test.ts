import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { DriveHttpError } from "./drive-import.ts";
import { createMediaRuntime, type MediaRuntime } from "./media-runtime.ts";

const URL = "https://drive.google.com/file/d/IdTeste123/view";

// Só o Drive é substituído: HTTP, disco, hash e ffprobe são reais.
function driveFixture(input: Buffer) {
  const starts: number[] = [];
  let failRead = false;
  let failAfter: number | null = null;
  let gate: (() => Promise<void>) | null = null;
  let md5 = createHash("md5").update(input).digest("hex");
  let tamanho = input.length;
  let nome = "aula.mp4";
  let metadataError: { status: number; message: string } | null = null;
  return {
    starts,
    set failRead(value: boolean) { failRead = value; },
    set failAfter(value: number | null) { failAfter = value; },
    set gate(value: (() => Promise<void>) | null) { gate = value; },
    set md5(value: string) { md5 = value; },
    set tamanho(value: number) { tamanho = value; },
    set nome(value: string) { nome = value; },
    set metadataError(value: { status: number; message: string } | null) { metadataError = value; },
    async metadata(fileId: string) {
      if (metadataError) throw new DriveHttpError(metadataError.status, metadataError.message);
      return { id: fileId, nome, tamanho, md5, mimeType: "video/mp4" };
    },
    async read(_fileId: string, start: number, total: number) {
      starts.push(start);
      if (failRead) throw new Error("rede caiu");
      const body = input.subarray(start);
      async function* chunks() {
        if (gate) await gate();
        if (failAfter !== null) {
          yield body.subarray(0, Math.min(failAfter, body.length));
          throw new Error("rede caiu");
        }
        yield body;
      }
      return { restarted: false, total, body: chunks() };
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(input: Buffer, env: Record<string, string | undefined> = {}) {
  const root = await mkdtemp(join(tmpdir(), "drive-upload-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const drive = driveFixture(input);
  let runtime: MediaRuntime;
  async function boot() {
    runtime = await createMediaRuntime({ root, env, drive, cleanupIntervalMs: 20, log: () => {} });
    const server = createServer((req, res) => { void runtime.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await runtime.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    };
    cleanups.push(close);
    return { base: `http://127.0.0.1:${address.port}`, close };
  }
  const app = await boot();
  async function importDrive(url = URL) {
    const response = await fetch(`${app.base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url }) });
    expect(response.status).toBe(202);
    return await response.json() as { id: string; transporte: string; nome: string; tamanhoTotal: number };
  }
  return { root, drive, app, boot, importDrive, isDriveEnabled: () => runtime.driveEnabled };
}

async function settled(base: string, id: string) {
  for (let i = 0; i < 250; i++) {
    const response = await fetch(`${base}/api/uploads/${id}`);
    expect(response.status).toBe(200);
    const state = await response.json() as { mediaId?: string; estado?: string };
    if (state.mediaId || state.estado === "failed") return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("importação não terminou");
}

it("publica a mídia validada do Drive e expõe o progresso do download", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  expect(f.isDriveEnabled()).toBe(true);
  const upload = await f.importDrive();
  expect(upload.transporte).toBe("drive");
  expect(upload.nome).toBe("aula.mp4");
  const result = await settled(f.app.base, upload.id);
  expect(result.mediaId).toBe(createHash("sha256").update(input).digest("hex"));
  const media = await (await fetch(`${f.app.base}/api/media`)).json() as { id: string }[];
  expect(media).toHaveLength(1);
  expect(await readFile(join(f.root, "pool", media[0]!.id))).toEqual(input);
  await expect.poll(() => readdir(join(f.root, ".tmp"))).not.toContain(upload.id);
});

it("sem chave, a importação responde 503 e a interface esconde o campo", async () => {
  const root = await mkdtemp(join(tmpdir(), "drive-sem-chave-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await createMediaRuntime({ root, env: {}, cleanupIntervalMs: 20, log: () => {} });
  cleanups.push(() => runtime.close());
  expect(runtime.driveEnabled).toBe(false);
  const server = createServer((req, res) => { void runtime.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url: URL }) });
  expect(response.status).toBe(503);
});

it("recusa link inválido, pasta, arquivo ausente e vazio", async () => {
  const f = await fixture(Buffer.from("x"));
  for (const url of ["", "https://example.com/a.mp4"]) {
    const response = await fetch(`${f.app.base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url }) });
    expect(response.status, url).toBe(400);
  }
  const folder = await fetch(`${f.app.base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url: "https://drive.google.com/drive/folders/abc123" }) });
  expect(folder.status).toBe(400);
  expect(await folder.json()).toMatchObject({ error: expect.stringContaining("pastas") });
  f.drive.metadataError = { status: 404, message: "arquivo não encontrado no Drive ou sem link público" };
  const missing = await fetch(`${f.app.base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url: URL }) });
  expect(missing.status).toBe(404);
  f.drive.metadataError = null;
  f.drive.tamanho = 0;
  const empty = await fetch(`${f.app.base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url: URL }) });
  expect(empty.status).toBe(400);
});

it("recusa mídia acima do máximo e higieniza o nome do Drive", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const tiny = await fixture(input, { DECUPA_UPLOAD_MAX_GB: "0.0000001" });
  const big = await fetch(`${tiny.app.base}/api/uploads/from-drive`, { method: "POST", body: JSON.stringify({ url: URL }) });
  expect(big.status).toBe(413);
  const f = await fixture(input);
  f.drive.nome = "aula/ao vivo\\final.mp4";
  const upload = await f.importDrive();
  expect(upload.nome).toBe("aula ao vivo final.mp4");
  expect(await settled(f.app.base, upload.id)).toHaveProperty("mediaId");
});

it("retoma o download do ponto da falha sem baixar tudo de novo", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  const at = Math.floor(input.length / 2);
  f.drive.failAfter = at;
  const upload = await f.importDrive();
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  expect(f.drive.starts).toEqual([0]);
  const failed = await (await fetch(`${f.app.base}/api/uploads/${upload.id}`)).json() as { offset: number };
  expect(failed.offset).toBe(at);
  f.drive.failAfter = null;
  expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/retry`, { method: "POST" })).status).toBe(202);
  expect(await settled(f.app.base, upload.id)).toHaveProperty("mediaId");
  expect(f.drive.starts).toEqual([0, at]);
});

it("hash divergente falha a validação, descarta o parcial e bloqueia retry", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  f.drive.md5 = "0".repeat(32);
  const upload = await f.importDrive();
  const failed = await settled(f.app.base, upload.id);
  expect(failed).toMatchObject({ estado: "failed" });
  expect((await (await fetch(`${f.app.base}/api/uploads/${upload.id}`)).json() as { status: number }).status).toBe(422);
  await expect(readFile(join(f.root, ".tmp", upload.id, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await (await fetch(`${f.app.base}/api/media`)).json()).toEqual([]);
  const retry = await fetch(`${f.app.base}/api/uploads/${upload.id}/retry`, { method: "POST" });
  expect(retry.status).toBe(409);
});

it("não publica download truncado e bloqueia retry de validação", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  f.drive.tamanho = input.length + 10;
  const upload = await f.importDrive();
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  expect(await (await fetch(`${f.app.base}/api/media`)).json()).toEqual([]);
  expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/retry`, { method: "POST" })).status).toBe(409);
});

it("cancelar durante o download responde sem esperar e impede publicação", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  let release!: () => void;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.drive.gate = async () => { started(); await blocked; };
  const upload = await f.importDrive();
  await reading;
  const cancel = fetch(`${f.app.base}/api/uploads/${upload.id}`, { method: "DELETE" });
  try {
    const status = await Promise.race([cancel.then(res => res.status), new Promise(resolve => setTimeout(() => resolve("bloqueado"), 300))]);
    expect(status).toBe(202);
  } finally { release(); await cancel; }
  await expect.poll(() => readdir(join(f.root, ".tmp"))).not.toContain(upload.id);
  await f.app.close();
  expect(await readdir(join(f.root, "pool"))).toEqual([]);
});

it("retoma sozinho o download em andamento após reiniciar", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  const at = Math.floor(input.length / 3);
  f.drive.failAfter = at;
  const upload = await f.importDrive();
  await settled(f.app.base, upload.id);
  // Queda no meio do download: fase downloading com o parcial no disco.
  const path = join(f.root, ".tmp", upload.id, "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.drive.phase = "downloading";
  await writeFile(path, JSON.stringify(state));
  await f.app.close();
  f.drive.failAfter = null;
  const resumed = await f.boot();
  expect(await settled(resumed.base, upload.id)).toHaveProperty("mediaId");
  expect(f.drive.starts.at(-1)).toBe(at);
});

it("expira download parado e conserva falha para retry explícito", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input, { DECUPA_UPLOAD_TTL_HOURS: "0" });
  let release!: () => void;
  let reached = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.drive.gate = async () => { reached = true; await blocked; };
  const upload = await f.importDrive();
  try {
    // A limpeza pode vencer a corrida com o job: either way, o parado expira.
    for (let i = 0; i < 250 && !reached; i++) {
      if (!(await readdir(join(f.root, ".tmp"))).includes(upload.id)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await expect.poll(() => readdir(join(f.root, ".tmp"))).not.toContain(upload.id);
  } finally { release(); }
  const failed = await fixture(Buffer.from("não é mídia"));
  const second = await failed.importDrive();
  await settled(failed.app.base, second.id);
  const path = join(failed.root, ".tmp", second.id, "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.atualizadoEm = 0;
  await writeFile(path, JSON.stringify(state));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(await readdir(join(failed.root, ".tmp"))).toContain(second.id);
});

it("rotas de outros transportes recusam o envio do Drive e vice-versa", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  let release!: () => void;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.drive.gate = async () => { started(); await blocked; };
  const upload = await f.importDrive();
  await reading;
  try {
    const patch = await fetch(`${f.app.base}/api/uploads/${upload.id}`, {
      method: "PATCH", headers: { "content-range": `bytes 0-0/${input.length}` }, body: "x",
    });
    expect(patch.status).toBe(409);
    expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/parts`, { method: "POST", body: "{}" })).status).toBe(409);
    expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/complete`, { method: "POST" })).status).toBe(409);
    // Retry durante o download só confirma; em envio local, recusa.
    expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/retry`, { method: "POST" })).status).toBe(202);
    const created = await fetch(`${f.app.base}/api/uploads`, { method: "POST", body: JSON.stringify({ nome: "a.mp4", tamanho: 10 }) });
    expect(created.status).toBe(201);
    const local = await created.json() as { id: string };
    expect((await fetch(`${f.app.base}/api/uploads/${local.id}/retry`, { method: "POST" })).status).toBe(409);
  } finally { release(); }
  await settled(f.app.base, upload.id);
});

it("reaproveita a mídia já importada do mesmo conteúdo", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  const first = await settled(f.app.base, (await f.importDrive()).id);
  const second = await settled(f.app.base, (await f.importDrive()).id);
  expect(first.mediaId).toBeTruthy();
  expect(second).toMatchObject({ mediaId: first.mediaId, estado: "deduped" });
  const media = await (await fetch(`${f.app.base}/api/media`)).json() as { id: string }[];
  expect(media).toHaveLength(1);
});
