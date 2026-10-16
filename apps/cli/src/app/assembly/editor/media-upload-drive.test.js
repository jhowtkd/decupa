import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { DriveMediaImport, UploadPausedError } from "./media-upload.js";

const LINK = "https://drive.google.com/file/d/IdTeste123/view";

const activeServers = new Set();
afterEach(async () => {
  await Promise.all([...activeServers].map(server => new Promise(resolve => server.close(resolve))));
  activeServers.clear();
});

function memoryStorage(initial = {}) {
  const values = new Map([["decupa.drive-imports.v1", JSON.stringify(initial)]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    readImports: () => JSON.parse(values.get("decupa.drive-imports.v1") || "{}"),
  };
}

async function fixture(handle) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://127.0.0.1");
    const result = await handle({ method: req.method, path: url.pathname, body: body && JSON.parse(body) });
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  activeServers.add(server);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const fetchImpl = (url, init) => fetch(new URL(url, base), init);
  return { fetchImpl };
}

function progressCollector() {
  const events = [];
  return { events, onProgress: (value) => events.push(value) };
}

it("importa um link novo até pronto, com progresso da importação", async () => {
  const calls = [];
  const { fetchImpl } = await fixture(({ method, path }) => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/uploads/from-drive") {
      return { status: 202, body: { id: "drive-1", transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: 100, nome: "aula.mp4" } };
    }
    if (method === "GET" && path === "/api/uploads/drive-1") {
      const polls = calls.filter(call => call === "GET /api/uploads/drive-1").length;
      if (polls === 1) return { body: { transporte: "drive", estado: "importing", offset: 40, tamanhoTotal: 100, nome: "aula.mp4" } };
      return { body: { mediaId: "m1", deduplicado: false, estado: "ready" } };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const storage = memoryStorage();
  const progress = progressCollector();
  const client = new DriveMediaImport({ fetchImpl, storage, onProgress: progress.onProgress });
  const result = await client.start(LINK);
  expect(result).toMatchObject({ mediaId: "m1" });
  expect(progress.events.at(-1)).toMatchObject({ percent: 100, state: "ready" });
  expect(progress.events.some(event => event.state === "importing" && event.percent === 40)).toBe(true);
  expect(progress.events[0]).toMatchObject({ nome: "aula.mp4" });
  expect(storage.readImports()).toEqual({});
});

it("link inválido falha com a mensagem do servidor", async () => {
  const { fetchImpl } = await fixture(() => ({ status: 400, body: { error: "pastas do Drive não são suportadas" } }));
  const client = new DriveMediaImport({ fetchImpl, storage: memoryStorage() });
  const error = await client.start(LINK).catch(error => error);
  expect(error).toMatchObject({ status: 400, message: "pastas do Drive não são suportadas" });
  await expect(client.start("   ")).rejects.toMatchObject({ status: 400 });
});

it("falha na importação é lançada e o próximo start retenta no servidor", async () => {
  let retried = false;
  const { fetchImpl } = await fixture(({ method, path }) => {
    if (method === "POST" && path === "/api/uploads/from-drive") {
      return { status: 202, body: { id: "drive-2", transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: 100, nome: "a.mp4" } };
    }
    if (method === "GET" && path === "/api/uploads/drive-2" && !retried) {
      return { body: { transporte: "drive", estado: "failed", error: "rede caiu", status: 502, tamanhoTotal: 100, offset: 0 } };
    }
    if (method === "POST" && path === "/api/uploads/drive-2/retry") {
      retried = true;
      return { status: 202, body: { transporte: "drive", estado: "importing" } };
    }
    if (method === "GET" && path === "/api/uploads/drive-2") {
      return { body: { mediaId: "m2", deduplicado: false, estado: "ready" } };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const storage = memoryStorage();
  const first = new DriveMediaImport({ fetchImpl, storage });
  await expect(first.start(LINK)).rejects.toMatchObject({ status: 502, message: "rede caiu" });
  expect(storage.readImports()[LINK]).toEqual({ id: "drive-2" });
  const second = new DriveMediaImport({ fetchImpl, storage });
  await expect(second.start(LINK)).resolves.toMatchObject({ mediaId: "m2" });
  expect(retried).toBe(true);
});

it("pausa a espera e retoma acompanhando o mesmo id", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let polls = 0;
  const { fetchImpl } = await fixture(({ method, path }) => {
    if (method === "POST" && path === "/api/uploads/from-drive") {
      return { status: 202, body: { id: "drive-3", transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: 100, nome: "a.mp4" } };
    }
    if (method === "GET" && path === "/api/uploads/drive-3") {
      polls += 1;
      if (polls === 1) return blocked.then(() => ({ body: { mediaId: "m3", deduplicado: false, estado: "ready" } }));
      return { body: { mediaId: "m3", deduplicado: true, estado: "deduped" } };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const storage = memoryStorage();
  const client = new DriveMediaImport({ fetchImpl, storage });
  const waiting = client.start(LINK);
  await new Promise(resolve => setTimeout(resolve, 50));
  client.pause();
  await expect(waiting).rejects.toBeInstanceOf(UploadPausedError);
  release();
  await expect(client.start(LINK)).resolves.toMatchObject({ mediaId: "m3", deduplicado: true });
  expect(polls).toBe(2);
});

it("cancelar avisa o servidor e esquece a importação", async () => {
  const calls = [];
  const { fetchImpl } = await fixture(({ method, path }) => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/uploads/from-drive") {
      return { status: 202, body: { id: "drive-4", transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: 100, nome: "a.mp4" } };
    }
    if (method === "DELETE" && path === "/api/uploads/drive-4") return { status: 202, body: {} };
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const storage = memoryStorage( { [LINK]: { id: "drive-4" } });
  const client = new DriveMediaImport({ fetchImpl, storage });
  await client.cancel(LINK);
  expect(calls).toContain("DELETE /api/uploads/drive-4");
  expect(storage.readImports()).toEqual({});
});

it("id expirado cria uma nova importação", async () => {
  const { fetchImpl } = await fixture(({ method, path }) => {
    if (method === "GET" && path === "/api/uploads/antigo") return { status: 404, body: { error: "envio não encontrado" } };
    if (method === "POST" && path === "/api/uploads/from-drive") {
      return { status: 202, body: { id: "drive-5", transporte: "drive", estado: "importing", offset: 0, tamanhoTotal: 100, nome: "a.mp4" } };
    }
    if (method === "GET" && path === "/api/uploads/drive-5") return { body: { mediaId: "m5", deduplicado: false, estado: "ready" } };
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const storage = memoryStorage( { [LINK]: { id: "antigo" } });
  const client = new DriveMediaImport({ fetchImpl, storage });
  await expect(client.start(LINK)).resolves.toMatchObject({ mediaId: "m5" });
  expect(storage.readImports()).toEqual({});
});
