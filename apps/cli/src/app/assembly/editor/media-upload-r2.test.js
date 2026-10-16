import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { ResumableMediaUpload } from "./media-upload.js";

const activeServers = new Set();
afterEach(async () => {
  await Promise.all([...activeServers].map(server => new Promise(resolve => server.close(resolve))));
  activeServers.clear();
});

function file() {
  return {
    name: "aula.mp4", size: 5, lastModified: 123,
    slice(start, end) { return new Uint8Array(end - start); },
  };
}

function memoryStorage(initial = {}) {
  const values = new Map([["decupa.uploads.v1", JSON.stringify(initial)]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    readUploads: () => JSON.parse(values.get("decupa.uploads.v1") || "{}"),
  };
}

async function fixture(handle, externalFetch = async () => { throw new Error("PUT R2 inesperado"); }) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://127.0.0.1");
    const result = await handle({ method: req.method, path: url.pathname, body: body && JSON.parse(body), req });
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  activeServers.add(server);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  // Control-plane requests use Node's real fetch over HTTP. Only the signed
  // object-store URL is intercepted, which keeps the client itself unmocked.
  const fetchImpl = (url, init) => String(url).startsWith("https://r2.test/")
    ? externalFetch(url, init)
    : fetch(new URL(url, base), init);
  return { fetchImpl, base };
}

it("pausa uma parte R2 em voo abortando o PUT direto", async () => {
  let putStarted;
  const started = new Promise(resolve => { putStarted = resolve; });
  let putSignal;
  const { fetchImpl } = await fixture(({ method, path }) => {
    if (method === "POST" && path === "/api/uploads") return { status: 201, body: { id: "r2-pause", transporte: "r2", offset: 0, tamanhoParte: 5 } };
    if (method === "GET" && path === "/api/uploads/r2-pause") return { body: { transporte: "r2", estado: "uploading", offset: 0, tamanhoParte: 5 } };
    if (method === "POST" && path.endsWith("/parts")) return { body: { url: "https://r2.test/part-1" } };
    throw new Error(`chamada de controle inesperada: ${method} ${path}`);
  }, (_url, init) => new Promise((_resolve, reject) => {
    putSignal = init.signal;
    putStarted();
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const storage = memoryStorage();
  const upload = new ResumableMediaUpload({ fetchImpl, storage });
  const pending = upload.start(file());
  await started;

  upload.pause();
  await expect(pending).rejects.toMatchObject({ name: "UploadPausedError" });
  expect(putSignal.aborted).toBe(true);
  expect(upload.state).toBe("pausado");
  expect(storage.readUploads()["aula.mp4\u00005\u0000123"]).toMatchObject({ id: "r2-pause", offset: 0 });
});

it("retoma estado failed chamando somente complete e consultando a importação", async () => {
  const calls = [];
  const storage = memoryStorage({ "aula.mp4\u00005\u0000123": { id: "r2-failed", offset: 5, tamanhoParte: 5 } });
  let statusReads = 0;
  const retryFixture = await fixture(({ method, path }) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === "/api/uploads/r2-failed") {
      return { body: ++statusReads === 1
        ? { transporte: "r2", estado: "failed", offset: 5, tamanhoParte: 5 }
        : { mediaId: "a".repeat(64) } };
    }
    if (method === "POST" && path === "/api/uploads/r2-failed/complete") return { status: 202, body: { transporte: "r2", estado: "importing" } };
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const upload = new ResumableMediaUpload({ fetchImpl: retryFixture.fetchImpl, storage });

  expect(await upload.start(file())).toMatchObject({ mediaId: "a".repeat(64) });
  expect(calls).toEqual([
    "GET /api/uploads/r2-failed",
    "POST /api/uploads/r2-failed/complete",
    "GET /api/uploads/r2-failed",
  ]);
  expect(storage.readUploads()).toEqual({});
});

it("mantém sessão persistida quando a tentativa de importação falha", async () => {
  const id = "r2-import-error";
  const storage = memoryStorage({ "aula.mp4\u00005\u0000123": { id, offset: 5, tamanhoParte: 5 } });
  const calls = [];
  let reads = 0;
  const retry = await fixture(({ method, path }) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === `/api/uploads/${id}`) {
      return { body: ++reads === 1
        ? { transporte: "r2", estado: "failed", offset: 5, tamanhoParte: 5 }
        : { estado: "failed", error: "mídia ilegível", status: 422 } };
    }
    if (method === "POST" && path === `/api/uploads/${id}/complete`) return { status: 202, body: { transporte: "r2", estado: "importing" } };
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
  const upload = new ResumableMediaUpload({ fetchImpl: retry.fetchImpl, storage });

  await expect(upload.start(file())).rejects.toMatchObject({ status: 422, message: "mídia ilegível" });
  expect(calls).toEqual([
    "GET /api/uploads/r2-import-error",
    "POST /api/uploads/r2-import-error/complete",
    "GET /api/uploads/r2-import-error",
  ]);
  expect(storage.readUploads()["aula.mp4\u00005\u0000123"]).toMatchObject({ id, offset: 5 });
});
