import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { createMediaRuntime, type MediaRuntime } from "./media-runtime.ts";

// Só o serviço externo é substituído: HTTP, disco, hash e ffprobe são reais.
function stagingFixture(input: Buffer) {
  const objects = new Map<string, Buffer>();
  const multiparts = new Map<string, { number: number; size: number; etag: string }[]>();
  let failDelete = false;
  let failRead = false;
  return {
    objects, multiparts,
    set failDelete(value: boolean) { failDelete = value; },
    set failRead(value: boolean) { failRead = value; },
    async create(key: string) { multiparts.set(key, []); return "multipart-1"; },
    async signPart(key: string, _upload: string, number: number) { return `https://r2.example/${key}?partNumber=${number}`; },
    async parts(key: string) { return multiparts.get(key) ?? []; },
    async complete(key: string) { objects.set(key, input); multiparts.delete(key); },
    async head(key: string) { const body = objects.get(key); return body ? { size: body.length, etag: '"object"' } : null; },
    async *read(key: string) { if (failRead) throw new Error("interrupção de rede"); yield objects.get(key)!; },
    async delete(key: string) { if (failDelete) throw new Error("R2 indisponível"); objects.delete(key); },
    async abort(key: string) { multiparts.delete(key); },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(input: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "r2-upload-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const staging = stagingFixture(input);
  let runtime: MediaRuntime;
  async function boot() {
    runtime = await createMediaRuntime({ root, env: {}, staging, cleanupIntervalMs: 20, log: () => {} });
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
  async function create(extra = {}) {
    const response = await fetch(`${app.base}/api/uploads`, { method: "POST", body: JSON.stringify({ nome: "clip.mp4", tamanho: input.length, ...extra }) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; transporte: string; tamanhoParte: number };
  }
  async function uploaded(id: string) {
    const key = [...staging.multiparts.keys()][0]!;
    staging.multiparts.set(key, [{ number: 1, size: input.length, etag: '"part-1"' }]);
    const response = await fetch(`${app.base}/api/uploads/${id}/complete`, { method: "POST" });
    expect(response.status).toBe(202);
    return key;
  }
  return { root, staging, app, boot, create, uploaded };
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

it("publica a mídia local validada antes de apagar o objeto R2", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  const upload = await f.create();
  expect(upload.transporte).toBe("r2");
  const signed = await fetch(`${f.app.base}/api/uploads/${upload.id}/parts`, { method: "POST", body: JSON.stringify({ numero: 1 }) });
  expect(signed.status).toBe(200);
  expect(await signed.json()).toMatchObject({ url: expect.stringContaining("https://r2.example/") });
  let validatedBeforeDelete = false;
  const remove = f.staging.delete;
  f.staging.delete = async key => {
    const media = await (await fetch(`${f.app.base}/api/media`)).json() as { id: string }[];
    expect(media).toHaveLength(1);
    expect(await readFile(join(f.root, "pool", media[0]!.id))).toEqual(input);
    validatedBeforeDelete = true;
    await remove(key);
  };
  await f.uploaded(upload.id);
  const result = await settled(f.app.base, upload.id);
  expect(result.mediaId).toBe(createHash("sha256").update(input).digest("hex"));
  await expect.poll(() => validatedBeforeDelete).toBe(true);
  await expect.poll(() => f.staging.objects.size).toBe(0);
});

it("preserva o objeto quando a validação falha e permite cancelar explicitamente", async () => {
  const f = await fixture(Buffer.from("isto não é mídia"));
  const upload = await f.create();
  const key = await f.uploaded(upload.id);
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  expect(f.staging.objects.has(key)).toBe(true);
  expect(await (await fetch(`${f.app.base}/api/media`)).json()).toEqual([]);
  expect((await fetch(`${f.app.base}/api/uploads/${upload.id}`, { method: "DELETE" })).status).toBe(202);
  await expect.poll(() => f.staging.objects.size).toBe(0);
});

it("recupera uma exclusão pendente após reiniciar e conserva o recibo", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  const upload = await f.create();
  f.staging.failDelete = true;
  const key = await f.uploaded(upload.id);
  const result = await settled(f.app.base, upload.id);
  expect(result.mediaId).toBeTruthy();
  expect(f.staging.objects.has(key)).toBe(true);
  await f.app.close();
  f.staging.failDelete = false;
  const resumed = await f.boot();
  expect(await settled(resumed.base, upload.id)).toMatchObject({ mediaId: result.mediaId });
  await expect.poll(() => f.staging.objects.size).toBe(0);
  expect(await readdir(join(f.root, ".completed"))).toContain(`${upload.id}.json`);
});

it("mantém a cópia R2 após download interrompido e repete a importação", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  const upload = await f.create();
  f.staging.failRead = true;
  const key = await f.uploaded(upload.id);
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  expect(f.staging.objects.has(key)).toBe(true);
  f.staging.failRead = false;
  expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/complete`, { method: "POST" })).status).toBe(202);
  expect(await settled(f.app.base, upload.id)).toHaveProperty("mediaId");
  await expect.poll(() => f.staging.objects.size).toBe(0);
});

it("recusa partes fora do arquivo e conclusão com tamanho incorreto", async () => {
  const f = await fixture(Buffer.from("12345"));
  const upload = await f.create();
  expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/parts`, { method: "POST", body: JSON.stringify({ numero: 2 }) })).status).toBe(400);
  const key = [...f.staging.multiparts.keys()][0]!;
  f.staging.multiparts.set(key, [{ number: 1, size: 4, etag: '"part-1"' }]);
  expect((await fetch(`${f.app.base}/api/uploads/${upload.id}/complete`, { method: "POST" })).status).toBe(409);
  await expect.poll(() => f.staging.objects.size).toBe(0);
});

it("retoma pelas partes confirmadas no R2 e recupera conclusão perdida antes de persistir", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  const upload = await f.create();
  const key = [...f.staging.multiparts.keys()][0]!;
  f.staging.multiparts.set(key, [{ number: 1, size: input.length, etag: '"part-1"' }]);
  expect(await (await fetch(`${f.app.base}/api/uploads/${upload.id}`)).json()).toMatchObject({ transporte: "r2", offset: input.length });
  // R2 concluiu, mas o processo caiu antes de gravar phase=importing.
  await f.staging.complete(key);
  await f.app.close();
  const resumed = await f.boot();
  expect(await settled(resumed.base, upload.id)).toHaveProperty("mediaId");
  await expect.poll(() => f.staging.objects.size).toBe(0);
});

it("não publica um download truncado nem apaga a cópia íntegra no R2", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  f.staging.read = async function* () { yield input.subarray(0, input.length - 1); };
  const upload = await f.create();
  const key = await f.uploaded(upload.id);
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  expect(f.staging.objects.has(key)).toBe(true);
  expect(await (await fetch(`${f.app.base}/api/media`)).json()).toEqual([]);
});

it("compara o SHA-256 original quando fornecido e preserva a origem em caso de divergência", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  const upload = await f.create({ sha256: "0".repeat(64) });
  const key = await f.uploaded(upload.id);
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  expect(f.staging.objects.has(key)).toBe(true);
  expect(await (await fetch(`${f.app.base}/api/media`)).json()).toEqual([]);
});

it("persiste o cancelamento antes de tentar excluir e repete após reiniciar", async () => {
  const f = await fixture(Buffer.from("inválido"));
  const upload = await f.create();
  const key = await f.uploaded(upload.id);
  await settled(f.app.base, upload.id);
  f.staging.failDelete = true;
  await fetch(`${f.app.base}/api/uploads/${upload.id}`, { method: "DELETE" });
  await f.app.close();
  // A limpeza remota indisponível não pode impedir o app de iniciar.
  const unavailable = await f.boot();
  expect((await fetch(`${unavailable.base}/api/media`)).status).toBe(200);
  await unavailable.close();
  f.staging.failDelete = false;
  await f.boot();
  await expect.poll(() => f.staging.objects.has(key)).toBe(false);
});

it("retoma automaticamente a importação em andamento após reiniciar", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  const upload = await f.create();
  const key = [...f.staging.multiparts.keys()][0]!;
  await f.staging.complete(key);
  const path = join(f.root, ".tmp", upload.id, "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.r2.phase = "importing";
  await writeFile(path, JSON.stringify(state));
  await f.app.close();
  const resumed = await f.boot();
  expect(await settled(resumed.base, upload.id)).toHaveProperty("mediaId");
  await expect.poll(() => f.staging.objects.size).toBe(0);
});

it("não ressuscita um envio cujo cancelamento ainda aguarda o R2", async () => {
  const f = await fixture(Buffer.from("inválido"));
  const upload = await f.create();
  await f.uploaded(upload.id);
  await settled(f.app.base, upload.id);
  f.staging.failDelete = true;
  await fetch(`${f.app.base}/api/uploads/${upload.id}`, { method: "DELETE" });
  const response = await fetch(`${f.app.base}/api/uploads/${upload.id}/complete`, { method: "POST" });
  expect(response.status).toBe(410);
});

it("cancelar durante o download responde sem esperar e impede publicação", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  let release!: () => void;
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.staging.read = async function* () { started(); await blocked; yield input; };
  const upload = await f.create();
  await f.uploaded(upload.id);
  await reading;
  const cancel = fetch(`${f.app.base}/api/uploads/${upload.id}`, { method: "DELETE" });
  try {
    const status = await Promise.race([cancel.then(res => res.status), new Promise(resolve => setTimeout(() => resolve("bloqueado"), 300))]);
    expect(status).toBe(202);
  } finally { release(); await cancel; }
  await f.app.close();
  expect(await readdir(join(f.root, "pool"))).toEqual([]);
});

it("libera a mídia pronta sem esperar a resposta de exclusão do R2", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  let release!: () => void;
  let started!: () => void;
  const deleting = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.staging.delete = async () => { started(); await blocked; };
  const upload = await f.create();
  await f.uploaded(upload.id);
  await deleting;
  try {
    const state = await (await fetch(`${f.app.base}/api/uploads/${upload.id}`)).json();
    expect(state).toHaveProperty("mediaId");
  } finally { release(); }
});

it("inicia o app mesmo com uma exclusão pendente sem resposta", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  const upload = await f.create();
  f.staging.failDelete = true;
  await f.uploaded(upload.id);
  await settled(f.app.base, upload.id);
  await f.app.close();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.staging.delete = async () => { await blocked; };
  const booting = f.boot();
  try {
    const result = await Promise.race([booting.then(() => "iniciado"), new Promise(resolve => setTimeout(() => resolve("bloqueado"), 300))]);
    expect(result).toBe("iniciado");
  } finally { release(); await booting; }
});

it("reconcilia objeto concluído antes da queda sem depender de consulta do navegador", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  const upload = await f.create();
  await f.app.close();
  const key = [...f.staging.multiparts.keys()][0]!;
  await f.staging.complete(key);
  await f.boot();
  const hash = createHash("sha256").update(input).digest("hex");
  await expect.poll(() => readdir(join(f.root, "pool"))).toContain(hash);
  expect((JSON.parse(await readFile(join(f.root, ".completed", `${upload.id}.json`), "utf8"))).mediaId).toBe(hash);
});

it("libera o parcial local após falha de importação, conservando o objeto R2", async () => {
  const input = await readFile(join(FIXTURES, "clip.mp4"));
  const f = await fixture(input);
  f.staging.read = async function* () { yield input.subarray(0, Math.floor(input.length / 2)); throw new Error("rede caiu"); };
  const upload = await f.create();
  const key = await f.uploaded(upload.id);
  expect(await settled(f.app.base, upload.id)).toMatchObject({ estado: "failed" });
  await expect(readFile(join(f.root, ".tmp", upload.id, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.staging.objects.has(key)).toBe(true);
});

it("limpa a pasta temporária após queda entre publicação e remoção do estado", async () => {
  const f = await fixture(await readFile(join(FIXTURES, "clip.mp4")));
  const upload = await f.create();
  const state = await readFile(join(f.root, ".tmp", upload.id, "state.json"));
  f.staging.failDelete = true;
  await f.uploaded(upload.id);
  await settled(f.app.base, upload.id);
  await f.app.close();
  const directory = join(f.root, ".tmp", upload.id);
  await mkdir(directory, { recursive: true });
  const old = JSON.parse(state.toString());
  old.r2.phase = "importing";
  await writeFile(join(directory, "state.json"), JSON.stringify(old));
  await f.boot();
  await expect.poll(() => readdir(join(f.root, ".tmp"))).not.toContain(upload.id);
});
