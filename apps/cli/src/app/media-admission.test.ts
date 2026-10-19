import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { createMediaRuntime, type MediaRuntime } from "./media-runtime.ts";
import type { R2Staging } from "./r2-staging.ts";
import type { DriveImport } from "./drive-import.ts";

// Os testes mantêm a validação parada para poder observar as cotas sem depender
// do tempo de ffprobe. I/O, hashing, persistência e HTTP continuam reais.
const probeControl = vi.hoisted(() => ({
  active: 0,
  maximum: 0,
  entered: 0,
  paths: [] as string[],
  release: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
  fail: false,
}));
const statfsControl = vi.hoisted(() => ({ override: undefined as {
  bavail: number; bsize: number; error?: boolean;
  materializedRoot?: string; budgetBytes?: number;
  tmp?: { bavail: number; bsize: number; error?: boolean };
  pool?: { bavail: number; bsize: number; error?: boolean };
} | undefined }));
const deviceControl = vi.hoisted(() => ({ tmp: undefined as number | undefined, pool: undefined as number | undefined }));
const statControl = vi.hoisted(() => ({
  capturePath: "",
  captured: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: vi.fn(async (...args: Parameters<typeof actual.statfs>) => {
      const real = await actual.statfs(...args);
      const path = String(args[0]);
      const override = path.endsWith("/pool") ? statfsControl.override?.pool ?? statfsControl.override
        : statfsControl.override?.tmp ?? statfsControl.override;
      if (override?.error) throw new Error("statfs failed");
      if (statfsControl.override?.materializedRoot) {
        const temporary = join(statfsControl.override.materializedRoot, ".tmp");
        let materialized = 0;
        for (const entry of await actual.readdir(temporary, { withFileTypes: true })) {
          if (entry.isDirectory()) materialized += await actual.stat(join(temporary, entry.name, "data")).then(file => file.size, () => 0);
        }
        return { ...real, bavail: 15 * 1024 ** 3 + statfsControl.override.budgetBytes! - materialized, bsize: 1 };
      }
      return override ? { ...real, bavail: override.bavail, bsize: override.bsize } : real;
    }),
    stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => {
      const real = await actual.stat(...args);
      const path = String(args[0]);
      if (path === statControl.capturePath) {
        statControl.capturePath = "";
        statControl.captured?.();
        await statControl.gate;
      }
      const dev = path.includes("/pool/") || path.endsWith("/pool") ? deviceControl.pool : deviceControl.tmp;
      return dev === undefined ? real : Object.assign(Object.create(Object.getPrototypeOf(real)), real, { dev });
    }),
  };
});
vi.mock("@decupa/media", () => ({
  probe: async (path: string) => {
    probeControl.active++;
    probeControl.entered++;
    probeControl.paths.push(path);
    probeControl.maximum = Math.max(probeControl.maximum, probeControl.active);
    try {
      await probeControl.gate;
      if (probeControl.fail) throw new Error("probe failure fixture");
      return { durationMs: 1000, hasAudio: true, hasVideo: true };
    } finally {
      probeControl.active--;
    }
  },
}));

const cleanups: (() => Promise<void>)[] = [];
let downloadRelease: (() => void) | undefined;
afterEach(async () => {
  downloadRelease?.();
  probeControl.release?.();
  statControl.release?.();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  probeControl.active = 0;
  probeControl.maximum = 0;
  probeControl.entered = 0;
  probeControl.paths = [];
  probeControl.release = undefined;
  probeControl.gate = undefined;
  probeControl.fail = false;
  statfsControl.override = undefined;
  deviceControl.tmp = undefined;
  deviceControl.pool = undefined;
  statControl.capturePath = "";
  statControl.captured = undefined;
  statControl.gate = undefined;
  statControl.release = undefined;
  downloadRelease = undefined;
  vi.restoreAllMocks();
});

function blocked() {
  let release!: () => void;
  let enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { gate, entered, release, enter };
}

async function boot(
  root: string,
  staging?: R2Staging,
  drive?: DriveImport,
  concurrency: { download?: number; validation?: number } = {},
) {
  statfsControl.override ??= { bavail: 1024 ** 4, bsize: 1 };
  let runtime!: MediaRuntime;
  runtime = await createMediaRuntime({
    root, staging, drive, cleanupIntervalMs: 60 * 60 * 1000, log: () => {},
    env: {
      DECUPA_UPLOAD_DOWNLOAD_CONCURRENCY: String(concurrency.download ?? 2),
      DECUPA_UPLOAD_VALIDATION_CONCURRENCY: String(concurrency.validation ?? 3),
      DECUPA_UPLOAD_MAX_GB: "1",
    },
  });
  const server = createServer((req, res) => {
    void runtime.handle(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  cleanups.push(close);
  return { base: `http://127.0.0.1:${port}`, close };
}

function contentRange(total: number): string { return `bytes 0-${total - 1}/${total}`; }
async function createLocal(base: string, size: number) {
  const response = await fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "small.mp4", tamanho: size }),
  });
  return { response, upload: response.status === 201 ? await response.json() as { id: string } : undefined };
}

it("retoma 100 imports R2/Drive com cotas de download e validação e expõe a fila", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = await readFile(join(FIXTURES, "clip.mp4"));
  const total = 100;
  const downloads = blocked();
  downloadRelease = downloads.release;
  const validation = blocked();
  probeControl.gate = validation.gate;
  probeControl.release = validation.release;
  let reads = 0;
  let activeReads = 0;
  let maximumReads = 0;
  const staging: R2Staging = {
    async create() { return "upload"; },
    async signPart() { return "https://r2.example/part"; },
    async parts() { return []; },
    async complete(_key, _upload, _parts) {},
    async head() { return { size: bytes.length, etag: '"fixture"' }; },
    async *read() {
      reads++;
      activeReads++;
      maximumReads = Math.max(maximumReads, activeReads);
      downloads.enter();
      try { await downloads.gate; yield bytes; }
      finally { activeReads--; }
    },
    async delete() {},
    async abort() {},
  };
  let driveReads = 0;
  const drive: DriveImport = {
    async metadata() { return { id: "unused", nome: "clip.mp4", tamanho: bytes.length, mimeType: "video/mp4" }; },
    async read() {
      driveReads++;
      activeReads++;
      maximumReads = Math.max(maximumReads, activeReads);
      downloads.enter();
      return { restarted: false, total: bytes.length, body: (async function* () {
        try { await downloads.gate; yield bytes; }
        finally { activeReads--; }
      })() };
    },
    async listMedia() { return { items: [], ignorados: 0 }; },
  };
  const temporary = join(root, ".tmp");
  await mkdir(temporary, { recursive: true });
  for (let index = 0; index < total; index++) {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const dir = join(temporary, id);
    await mkdir(dir);
    const isR2 = index % 2 === 0;
    await writeFile(join(dir, "data"), Buffer.alloc(0));
    await writeFile(join(dir, "state.json"), JSON.stringify({
      nome: `clip-${index}.mp4`, tamanhoTotal: bytes.length, recebido: 0,
      criadoEm: Date.now(), atualizadoEm: Date.now(),
      ...(isR2
        ? { r2: { key: `key-${index}`, upload: "upload", partBytes: bytes.length, phase: "importing" } }
        : { drive: { fileId: `file-${index}`, phase: "downloading" } }),
    }));
  }

  const app = await boot(root, staging, drive);
  await downloads.entered;
  await vi.waitFor(() => expect(activeReads).toBeGreaterThanOrEqual(2));
  expect(maximumReads).toBeLessThanOrEqual(2);
  expect(reads + driveReads).toBeLessThan(total);

  const waitingIds = Array.from({ length: total }, (_, index) => index + 1).map(index =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const waiting = await Promise.all(waitingIds.map(async id => {
    const response = await fetch(`${app.base}/api/uploads/${id}`);
    return response.json() as Promise<Record<string, unknown>>;
  }));
  const queued = waiting.find(state => state.fila && typeof state.fila === "object");
  expect(queued).toBeDefined();
  expect(queued).toMatchObject({ estado: "importing", fila: {
    etapa: expect.stringMatching(/^(download|validation)$/),
    estado: expect.stringMatching(/^(waiting|running)$/), posicao: expect.any(Number),
  } });
  const queuedId = waitingIds[waiting.indexOf(queued!)!]!;
  const persisted = JSON.parse(await readFile(join(root, ".tmp", queuedId, "state.json"), "utf8"));
  expect(persisted.fila).toMatchObject({
    etapa: expect.stringMatching(/^(download|validation)$/),
    estado: expect.stringMatching(/^(waiting|running)$/), posicao: expect.any(Number),
  });

  downloads.release();
  await vi.waitFor(() => expect(probeControl.entered).toBeGreaterThan(0));
  expect(probeControl.maximum).toBeLessThanOrEqual(3);
  validation.release();
});

it("não deixa um download antigo sem espaço bloquear um menor admitido", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-download-starvation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const margin = 15 * 1024 * 1024 * 1024;
  deviceControl.tmp = 51;
  deviceControl.pool = 51;
  statfsControl.override = { bavail: margin + 200, bsize: 1 };
  const largeId = "00000000-0000-4000-8000-000000000401";
  const smallId = "00000000-0000-4000-8000-000000000402";
  const smallRead = blocked();
  downloadRelease = smallRead.release;
  const readKeys: string[] = [];
  const staging: R2Staging = {
    async create() { return "upload"; }, async signPart() { return "url"; },
    async parts() { return []; }, async complete() {},
    async head(key) { return { size: key === "large" ? 200 : 100, etag: key }; },
    async *read(key) {
      readKeys.push(key);
      if (key === "small") {
        smallRead.enter();
        await smallRead.gate;
      }
      yield Buffer.alloc(key === "large" ? 200 : 100);
    },
    async delete() {}, async abort() {},
  };
  const temporary = join(root, ".tmp");
  for (const [id, key, size, created] of [
    [largeId, "large", 200, 1], [smallId, "small", 100, 2],
  ] as const) {
    const dir = join(temporary, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data"), Buffer.alloc(0));
    await writeFile(join(dir, "state.json"), JSON.stringify({
      nome: `${key}.mp4`, tamanhoTotal: size, recebido: 0, reserva: true,
      criadoEm: created, atualizadoEm: created,
      r2: { key, upload: "multipart", partBytes: size, phase: "importing" },
    }));
  }
  await boot(root, staging, undefined, { download: 1, validation: 1 });
  await vi.waitFor(() => expect(readKeys).toContain("small"));
  expect(readKeys).toEqual(["small"]);
});

it("não deixa uma validação antiga sem espaço bloquear uma menor admitida", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-validation-starvation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const margin = 15 * 1024 * 1024 * 1024;
  deviceControl.tmp = 61;
  deviceControl.pool = 61;
  statfsControl.override = { bavail: margin + 150, bsize: 1 };
  const largeId = "00000000-0000-4000-8000-000000000501";
  const smallId = "00000000-0000-4000-8000-000000000502";
  const temporary = join(root, ".tmp");
  const baseTime = Date.now();
  for (const [id, key, size, created] of [
    [largeId, "large", 200, baseTime], [smallId, "small", 100, baseTime + 1],
  ] as const) {
    const dir = join(temporary, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data"), Buffer.alloc(size));
    await writeFile(join(dir, "state.json"), JSON.stringify({
      nome: `${key}.mp4`, tamanhoTotal: size, recebido: size, reserva: true,
      criadoEm: created, atualizadoEm: Date.now(),
    }));
  }
  const validation = blocked();
  probeControl.gate = validation.gate;
  probeControl.release = validation.release;
  await boot(root, undefined, undefined, { download: 1, validation: 1 });
  await vi.waitFor(() => expect(probeControl.paths.some(path => path.includes(smallId))).toBe(true));
  expect(probeControl.paths.some(path => path.includes(largeId))).toBe(false);
});

it("usa a mesma cota de validação para PATCH local e publicação", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-local-validation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixtures = ["clip.mp4", "vertical-360x640.mov", "rotated-90.mov", "raw.wav", "tone-gap.wav"];
  const inputs = await Promise.all(fixtures.map(name => readFile(join(FIXTURES, name))));
  const validation = blocked();
  probeControl.gate = validation.gate;
  probeControl.release = validation.release;
  const app = await boot(root);
  const pending = Promise.all(inputs.map(async (input, index) => {
    const created = await fetch(`${app.base}/api/uploads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: fixtures[index], tamanho: input.length }),
    });
    expect(created.status).toBe(201);
    const upload = await created.json() as { id: string };
    return fetch(`${app.base}/api/uploads/${upload.id}`, {
      method: "PATCH", headers: { "Content-Range": contentRange(input.length) }, body: input,
    });
  }));
  await vi.waitFor(() => expect(probeControl.entered).toBeGreaterThan(0));
  expect(probeControl.maximum).toBeLessThanOrEqual(3);
  validation.release();
  const responses = await pending;
  expect(responses.every(response => response.status === 201)).toBe(true);
});

it("permite GET e DELETE enquanto a validação local está bloqueada", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-cancel-probe-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = await readFile(join(FIXTURES, "clip.mp4"));
  const validation = blocked();
  probeControl.gate = validation.gate;
  probeControl.release = validation.release;
  const app = await boot(root);
  const created = await createLocal(app.base, bytes.length);
  expect(created.response.status).toBe(201);
  const patch = fetch(`${app.base}/api/uploads/${created.upload!.id}`, {
    method: "PATCH", headers: { "Content-Range": contentRange(bytes.length) }, body: bytes,
  });
  await vi.waitFor(() => expect(probeControl.entered).toBeGreaterThan(0));
  const get = await fetch(`${app.base}/api/uploads/${created.upload!.id}`);
  expect(get.status).toBe(200);
  expect(await get.json()).toMatchObject({ estado: "verifying", fila: { etapa: "validation", estado: "running" } });

  let deleted = false;
  const deletion = fetch(`${app.base}/api/uploads/${created.upload!.id}`, { method: "DELETE" }).then(response => {
    deleted = true;
    return response;
  });
  await vi.waitFor(() => expect(deleted).toBe(true));
  expect((await deletion).status).toBe(204);
  validation.release();
  await patch;
  await expect.poll(async () => (await fetch(`${app.base}/api/uploads/${created.upload!.id}`)).status).toBe(404);
  expect(await (await fetch(`${app.base}/api/media`)).json()).toEqual([]);
});

it("reserva bytes atomicamente entre dois uploads locais concorrentes", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-space-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const margin = 15 * 1024 * 1024 * 1024;
  statfsControl.override = { bavail: margin + 250, bsize: 1 };
  const app = await boot(root);
  const create = () => fetch(`${app.base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "small.mp4", tamanho: 100 }),
  });
  const responses = await Promise.all([create(), create()]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 507]);
});

it("compartilha o ledger entre runtimes já iniciados no mesmo processo e raiz", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-same-process-runtimes-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 250, bsize: 1 };
  const first = await boot(root);
  const second = await boot(root);
  const create = (base: string) => fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "small.mp4", tamanho: 100 }),
  });
  const responses = await Promise.all([create(first.base), create(second.base)]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 507]);
});

it("boot concorrente herda reserva Drive ativa sem duplicar o worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-boot-active-drive-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const margin = 15 * 1024 * 1024 * 1024;
  statfsControl.override = { bavail: margin + 250, bsize: 1 };
  deviceControl.tmp = 91;
  deviceControl.pool = 91;
  const bytes = Buffer.alloc(100, 7);
  const download = blocked();
  downloadRelease = download.release;
  let reads = 0;
  const drive: DriveImport = {
    async metadata(id) { return { id, nome: "remote.mp4", tamanho: bytes.length, mimeType: "video/mp4" }; },
    async read() {
      reads++;
      download.enter();
      return { restarted: false, total: bytes.length, body: (async function* () {
        await download.gate;
        yield bytes;
      })() };
    },
    async listMedia() { return { items: [], ignorados: 0 }; },
  };
  const first = await boot(root, undefined, drive, { download: 1, validation: 1 });
  const started = await fetch(`${first.base}/api/uploads/from-drive`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" }),
  });
  expect(started.status).toBe(202);
  const importUpload = await started.json() as { id: string };
  await download.entered;

  const secondAndPost = boot(root, undefined, drive, { download: 1, validation: 1 }).then(async second => ({
    second,
    response: await createLocal(second.base, 50),
  }));
  const { second, response } = await secondAndPost;
  expect(response.response.status).toBe(507);
  const activeState = JSON.parse(await readFile(join(root, ".tmp", importUpload.id, "state.json"), "utf8")) as { reserva?: boolean };
  expect(activeState.reserva).toBe(true);
  expect(reads).toBe(1);

  download.release();
  await expect.poll(async () => {
    const response = await fetch(`${first.base}/api/uploads/${importUpload.id}`);
    return (await response.json() as { estado?: string }).estado;
  }).toBe("ready");
  await first.close();
  expect((await createLocal(second.base, 50)).response.status).toBe(201);
  await second.close();
});

it("exige margem fixa de 15 GiB para admitir um upload local", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-margin-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 99, bsize: 1 };
  const app = await boot(root);
  const response = await fetch(`${app.base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "small.mp4", tamanho: 100 }),
  });
  expect(response.status, await response.clone().text()).toBe(507);
});

it("fecha a admissão com 507 quando statfs falha", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-statfs-error-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 0, bsize: 0, error: true };
  const app = await boot(root);
  const response = await fetch(`${app.base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "small.mp4", tamanho: 100 }),
  });
  expect(response.status).toBe(507);
});

it("conta 2V no mesmo device, V por device distinto e desconta parcial materializado", async () => {
  const margin = 15 * 1024 * 1024 * 1024;
  const create = (base: string) => fetch(`${base}/api/uploads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "small.mp4", tamanho: 100 }),
  });

  const sameDeviceRoot = await mkdtemp(join(tmpdir(), "media-admission-same-device-"));
  cleanups.push(() => rm(sameDeviceRoot, { recursive: true, force: true }));
  deviceControl.tmp = 41;
  deviceControl.pool = 41;
  statfsControl.override = { bavail: margin + 199, bsize: 1 };
  let app = await boot(sameDeviceRoot);
  expect((await create(app.base)).status).toBe(507);

  const distinctDevicesRoot = await mkdtemp(join(tmpdir(), "media-admission-distinct-devices-"));
  cleanups.push(() => rm(distinctDevicesRoot, { recursive: true, force: true }));
  deviceControl.tmp = 41;
  deviceControl.pool = 42;
  statfsControl.override = {
    bavail: margin, bsize: 1,
    tmp: { bavail: margin + 100, bsize: 1 },
    pool: { bavail: margin + 100, bsize: 1 },
  };
  app = await boot(distinctDevicesRoot);
  expect((await create(app.base)).status).toBe(201);

  const partialRoot = await mkdtemp(join(tmpdir(), "media-admission-partial-"));
  cleanups.push(() => rm(partialRoot, { recursive: true, force: true }));
  deviceControl.tmp = 43;
  deviceControl.pool = 43;
  statfsControl.override = { bavail: margin + 399, bsize: 1 };
  const id = "00000000-0000-4000-8000-000000000101";
  const temporary = join(partialRoot, ".tmp", id);
  await mkdir(temporary, { recursive: true });
  await writeFile(join(temporary, "data"), Buffer.alloc(40));
  await writeFile(join(temporary, "state.json"), JSON.stringify({
    nome: "partial.mp4", tamanhoTotal: 100, recebido: 40, reserva: true,
    criadoEm: Date.now(), atualizadoEm: Date.now(),
  }));
  app = await boot(partialRoot);
  expect((await create(app.base)).status).toBe(201);
});

it("libera a reserva ao cancelar um upload local", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-cancel-release-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 250, bsize: 1 };
  const app = await boot(root);
  const first = await createLocal(app.base, 100);
  expect(first.response.status).toBe(201);
  expect((await createLocal(app.base, 100)).response.status).toBe(507);
  expect((await fetch(`${app.base}/api/uploads/${first.upload!.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await createLocal(app.base, 100)).response.status).toBe(201);
});

it("libera a reserva quando o PATCH local falha na validação", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-failure-release-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("não é mídia");
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + bytes.length * 2, bsize: 1 };
  const app = await boot(root);
  const first = await createLocal(app.base, bytes.length);
  expect(first.response.status).toBe(201);
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(507);
  probeControl.fail = true;
  const failed = await fetch(`${app.base}/api/uploads/${first.upload!.id}`, {
    method: "PATCH", headers: { "Content-Range": contentRange(bytes.length) }, body: bytes,
  });
  expect(failed.status).toBe(422);
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(201);
});

it("libera a reserva após publicar a mídia local", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-publish-release-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = await readFile(join(FIXTURES, "clip.mp4"));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + bytes.length * 2, bsize: 1 };
  const app = await boot(root);
  const first = await createLocal(app.base, bytes.length);
  expect(first.response.status).toBe(201);
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(507);
  const published = await fetch(`${app.base}/api/uploads/${first.upload!.id}`, {
    method: "PATCH", headers: { "Content-Range": contentRange(bytes.length) }, body: bytes,
  });
  expect(published.status).toBe(201);
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(201);
});

it("reserva espaço do Drive antes de iniciar o download e libera ao cancelar", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-drive-reservation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(100, 1);
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 200, bsize: 1 };
  const download = blocked();
  downloadRelease = download.release;
  const drive: DriveImport = {
    async metadata(id) { return { id, nome: "remote.mp4", tamanho: bytes.length, mimeType: "video/mp4" }; },
    async read() {
      download.enter();
      return { restarted: false, total: bytes.length, body: (async function* () {
        await download.gate;
        yield bytes;
      })() };
    },
    async listMedia() { return { items: [], ignorados: 0 }; },
  };
  const app = await boot(root, undefined, drive);
  const driveStart = await fetch(`${app.base}/api/uploads/from-drive`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" }),
  });
  expect(driveStart.status).toBe(202);
  const upload = await driveStart.json() as { id: string };
  await download.entered;
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(507);
  expect((await fetch(`${app.base}/api/uploads/${upload.id}`, { method: "DELETE" })).status).toBe(202);
  download.release();
  await expect.poll(async () => (await fetch(`${app.base}/api/uploads/${upload.id}`)).status).toBe(404);
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(201);
});

it("não admite sobre-reserva quando Drive reinicia e trunca parcial durante stat", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-drive-restart-race-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const margin = 15 * 1024 * 1024 * 1024;
  const id = "00000000-0000-4000-8000-000000000601";
  const partial = join(root, ".tmp", id, "data");
  await mkdir(join(root, ".tmp", id), { recursive: true });
  await writeFile(partial, Buffer.alloc(80));
  await writeFile(join(root, ".tmp", id, "state.json"), JSON.stringify({
    nome: "drive.mp4", tamanhoTotal: 100, recebido: 80, reserva: true,
    criadoEm: Date.now(), atualizadoEm: Date.now(),
    drive: { fileId: "drive-file", phase: "downloading" },
  }));
  statfsControl.override = { bavail: margin + 250, bsize: 1, materializedRoot: root, budgetBytes: 250 };
  deviceControl.tmp = 71;
  deviceControl.pool = 71;

  const restart = blocked();
  const readEntered = blocked();
  const drive: DriveImport = {
    async metadata(fileId) { return { id: fileId, nome: "drive.mp4", tamanho: 100, mimeType: "video/mp4" }; },
    async read() {
      readEntered.enter();
      await restart.gate;
      return { restarted: true, total: 100, body: (async function* () { yield Buffer.alloc(100); })() };
    },
    async listMedia() { return { items: [], ignorados: 0 }; },
  };
  const capture = blocked();
  const app = await boot(root, undefined, drive, { download: 1, validation: 1 });
  await readEntered.entered;
  statControl.capturePath = partial;
  statControl.captured = capture.enter;
  statControl.gate = capture.gate;
  statControl.release = capture.release;

  const competing = createLocal(app.base, 50);
  await capture.entered;
  restart.release();
  // The original implementation truncates without the accounting lock. Let that
  // operation reach the file before releasing the deliberately stale stat snapshot.
  // With the fixed implementation the timeout wins and releasing the gate lets
  // truncation continue after the capacity check is serialized.
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await Promise.race([
    vi.waitFor(async () => expect((await actualFs.stat(partial)).size).toBe(0), { timeout: 100 }).catch(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, 100)),
  ]);
  capture.release();

  const admitted = await competing;
  expect(admitted.response.status).toBe(507);
  const state = JSON.parse(await readFile(join(root, ".tmp", id, "state.json"), "utf8")) as { reserva?: boolean };
  expect(state.reserva).toBe(true);
  await expect.poll(() => readFile(partial).then(data => data.length)).toBe(0);
});

it("não admite sobre-reserva quando PATCH local falha e reverte o parcial durante stat", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-patch-rollback-race-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const margin = 15 * 1024 * 1024 * 1024;
  statfsControl.override = { bavail: margin + 250, bsize: 1, materializedRoot: root, budgetBytes: 250 };
  deviceControl.tmp = 81;
  deviceControl.pool = 81;
  const app = await boot(root);
  const first = await createLocal(app.base, 100);
  expect(first.response.status).toBe(201);
  const partial = join(root, ".tmp", first.upload!.id, "data");
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    stream = controller;
    controller.enqueue(Buffer.alloc(80, 1));
  } });
  const patching = fetch(`${app.base}/api/uploads/${first.upload!.id}`, {
    method: "PATCH", headers: { "Content-Range": "bytes 0-89/100" }, body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await vi.waitFor(async () => expect((await actualFs.stat(partial)).size).toBe(80));
  const capture = blocked();
  statControl.capturePath = partial;
  statControl.captured = capture.enter;
  statControl.gate = capture.gate;
  statControl.release = capture.release;
  const competing = createLocal(app.base, 50);
  await capture.entered;
  stream.close();
  await Promise.race([
    vi.waitFor(async () => expect((await actualFs.stat(partial)).size).toBe(0), { timeout: 100 }).catch(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, 100)),
  ]);
  capture.release();
  expect((await patching).status).toBe(400);
  expect((await competing).response.status).toBe(507);
  await expect.poll(() => actualFs.stat(partial).then(file => file.size)).toBe(0);
});

it("reconcilia uma reserva órfã quando o recibo de publicação já existe", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-receipt-reconcile-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 200, bsize: 1 };
  const id = "00000000-0000-4000-8000-000000000201";
  const mediaId = "a".repeat(64);
  const bytes = Buffer.alloc(100, 2);
  await mkdir(join(root, ".tmp", id), { recursive: true });
  await mkdir(join(root, ".completed"), { recursive: true });
  await mkdir(join(root, "pool"), { recursive: true });
  await writeFile(join(root, ".tmp", id, "data"), bytes);
  await writeFile(join(root, ".tmp", id, "state.json"), JSON.stringify({
    nome: "published.mp4", tamanhoTotal: 100, recebido: 100, reserva: true,
    criadoEm: Date.now(), atualizadoEm: Date.now(),
  }));
  await writeFile(join(root, "pool", mediaId), bytes);
  await writeFile(join(root, ".completed", `${id}.json`), JSON.stringify({ mediaId, deduplicado: false, expiraEm: Date.now() + 60_000 }));
  const app = await boot(root);
  expect((await createLocal(app.base, 100)).response.status).toBe(201);
  await expect.poll(() => readFile(join(root, ".tmp", id, "state.json"), "utf8").then(() => true, () => false)).toBe(false);
});

it("reserva espaço para um envio R2 antes de aceitar outro e libera ao cancelar", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-r2-reservation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 250, bsize: 1 };
  const staging: R2Staging = {
    async create() { return "multipart"; }, async signPart() { return "https://r2.example/part"; },
    async parts() { return []; }, async complete() {}, async head() { return null; },
    async *read() {}, async delete() {}, async abort() {},
  };
  const app = await boot(root, staging);
  const first = await createLocal(app.base, 100);
  expect(first.response.status).toBe(201);
  expect((await createLocal(app.base, 100)).response.status).toBe(507);
  expect((await fetch(`${app.base}/api/uploads/${first.upload!.id}`, { method: "DELETE" })).status).toBe(202);
  await expect.poll(async () => (await fetch(`${app.base}/api/uploads/${first.upload!.id}`)).status).toBe(404);
  expect((await createLocal(app.base, 100)).response.status).toBe(201);
});

it("libera a reserva R2 depois que a validação da importação falha", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-r2-failure-release-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("invalid media");
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + bytes.length * 2 + 10, bsize: 1 };
  probeControl.fail = true;
  const staging: R2Staging = {
    async create() { return "multipart"; }, async signPart() { return "https://r2.example/part"; },
    async parts() { return [{ number: 1, size: bytes.length, etag: '"part"' }]; },
    async complete() {}, async head() { return { size: bytes.length, etag: '"object"' }; },
    async *read() { yield bytes; }, async delete() {}, async abort() {},
  };
  const app = await boot(root, staging);
  const first = await createLocal(app.base, bytes.length);
  expect(first.response.status).toBe(201);
  expect((await fetch(`${app.base}/api/uploads/${first.upload!.id}/complete`, { method: "POST" })).status).toBe(202);
  await expect.poll(async () => {
    const response = await fetch(`${app.base}/api/uploads/${first.upload!.id}`);
    return (await response.json() as { estado?: string }).estado;
  }).toBe("failed");
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(201);
});

it("libera a reserva R2 quando HEAD falha antes de iniciar a importação", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-r2-head-retry-release-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("valid bytes fixture");
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + bytes.length * 2 + 20, bsize: 1 };
  probeControl.fail = true;
  let headCalls = 0;
  const staging: R2Staging = {
    async create() { return "multipart"; }, async signPart() { return "https://r2.example/part"; },
    async parts() { return [{ number: 1, size: bytes.length, etag: '"part"' }]; },
    async complete() {}, async head() {
      if (++headCalls > 1) throw new Error("HEAD unavailable on retry");
      return { size: bytes.length, etag: '"object"' };
    },
    async *read() { yield bytes; }, async delete() {}, async abort() {},
  };
  const app = await boot(root, staging);
  const first = await createLocal(app.base, bytes.length);
  expect(first.response.status).toBe(201);
  const firstCompletion = await fetch(`${app.base}/api/uploads/${first.upload!.id}/complete`, { method: "POST" });
  expect(firstCompletion.status).toBe(202);
  await expect.poll(async () => JSON.parse(await readFile(join(root, ".tmp", first.upload!.id, "state.json"), "utf8")) as { r2?: { phase?: string } })
    .toMatchObject({ r2: { phase: "failed" } });
  probeControl.fail = false;
  const retry = await fetch(`${app.base}/api/uploads/${first.upload!.id}/complete`, { method: "POST" });
  expect(retry.status).not.toBe(202);
  const state = JSON.parse(await readFile(join(root, ".tmp", first.upload!.id, "state.json"), "utf8")) as { reserva?: boolean };
  expect(state.reserva).toBe(false);
  expect((await createLocal(app.base, bytes.length)).response.status).toBe(201);
});

it("reconcilia reservas no boot quando só há capacidade para uma mídia", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-admission-boot-capacity-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  statfsControl.override = { bavail: 15 * 1024 * 1024 * 1024 + 250, bsize: 1 };
  const ids = ["00000000-0000-4000-8000-000000000301", "00000000-0000-4000-8000-000000000302"];
  for (const id of ids) {
    await mkdir(join(root, ".tmp", id), { recursive: true });
    await writeFile(join(root, ".tmp", id, "data"), Buffer.alloc(0));
    await writeFile(join(root, ".tmp", id, "state.json"), JSON.stringify({
      nome: "pending.mp4", tamanhoTotal: 100, recebido: 0, reserva: true,
      criadoEm: Date.now(), atualizadoEm: Date.now(),
    }));
  }
  const app = await boot(root);
  expect((await createLocal(app.base, 100)).response.status).toBe(507);
  expect((await fetch(`${app.base}/api/uploads/${ids[0]}`, { method: "DELETE" })).status).toBe(204);
  expect((await createLocal(app.base, 100)).response.status).toBe(201);
  const unreserved = JSON.parse(await readFile(join(root, ".tmp", ids[1], "state.json"), "utf8"));
  expect(unreserved.reserva).toBe(false);
});
