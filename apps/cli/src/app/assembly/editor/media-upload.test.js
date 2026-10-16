import { expect, it } from "vitest";
import { ResumableMediaUpload } from "./media-upload.js";

function file(name = "aula.mp4") {
  return {
    name, size: 5, lastModified: 123,
    slice(start, end) { return new Uint8Array(end - start); },
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

it("retoma pelo estado persistido e envia partes sequenciais", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const ranges = [];
  let calls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") return response({ id: "upload-1", offset: 0, tamanhoParte: 3 }, 201);
    if (init.method === "PATCH") {
      ranges.push(init.headers["Content-Range"]);
      calls += 1;
      return calls === 2 ? response({ mediaId: "a".repeat(64), deduplicado: false }, 201) : response({ offset: 3 });
    }
    throw new Error(`chamada inesperada: ${url}`);
  };
  const upload = new ResumableMediaUpload({ fetchImpl, storage });
  const result = await upload.start(file());
  expect(result.mediaId).toBe("a".repeat(64));
  expect(ranges).toEqual(["bytes 0-2/5", "bytes 3-4/5"]);

  const resumedRanges = [];
  const resumed = new ResumableMediaUpload({
    storage,
    fetchImpl: async (url, init = {}) => {
      if (!init.method || init.method === "GET") return response({ offset: 3, tamanhoTotal: 5, estado: "uploading" });
      if (init.method === "PATCH") {
        resumedRanges.push(init.headers["Content-Range"]);
        return response({ mediaId: "b".repeat(64), deduplicado: false }, 201);
      }
      throw new Error(`chamada inesperada: ${url}`);
    },
  });
  // O primeiro envio terminou e limpou o estado; esta segunda sessão usa uma
  // entrada persistida criada explicitamente, como depois de uma queda.
  storage.setItem("decupa.uploads.v1", JSON.stringify({ ["aula.mp4\u00005\u0000123"]: { id: "upload-1", offset: 3 } }));
  await resumed.start(file());
  expect(resumedRanges).toEqual(["bytes 3-4/5"]);
});

it("usa o tamanho de parte informado pelo servidor ao retomar", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  storage.setItem("decupa.uploads.v1", JSON.stringify({ ["aula.mp4\u00005\u0000123"]: { id: "upload-2", offset: 2 } }));
  const ranges = [];
  let patches = 0;
  const upload = new ResumableMediaUpload({
    storage,
    fetchImpl: async (url, init = {}) => {
      if (!init.method || init.method === "GET") return response({ offset: 2, tamanhoTotal: 5, tamanhoParte: 2, estado: "uploading" });
      if (init.method === "PATCH") {
        ranges.push(init.headers["Content-Range"]);
        patches += 1;
        return patches === 2 ? response({ mediaId: "c".repeat(64), deduplicado: false }, 201) : response({ offset: 4 });
      }
      throw new Error(`chamada inesperada: ${url}`);
    },
  });
  await upload.start(file());
  expect(ranges).toEqual(["bytes 2-3/5", "bytes 4-4/5"]);
});

it("distingue envio parado por erro de envio pausado e concluído", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let fail = true;
  const upload = new ResumableMediaUpload({
    storage,
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") return response({ id: "upload-3", offset: 0, tamanhoParte: 5 }, 201);
      if (!init.method || init.method === "GET") return response({ offset: 0, tamanhoTotal: 5, tamanhoParte: 5, estado: "uploading" });
      if (init.method === "PATCH" && fail) { fail = false; throw new Error("rede caiu"); }
      if (init.method === "PATCH") return response({ mediaId: "d".repeat(64), deduplicado: false }, 201);
      throw new Error(`chamada inesperada: ${url}`);
    },
  });
  await expect(upload.start(file())).rejects.toThrow("rede caiu");
  expect(upload.paused).toBe(false);
  expect(upload.state).toBe("parado");
  await upload.start(file());
  expect(upload.state).toBe("concluido");
  upload.pause();
  expect(upload.state).toBe("concluido");
});

it("marca como parado um erro no GET inicial e permite retry no primeiro clique", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  storage.setItem("decupa.uploads.v1", JSON.stringify({ ["aula.mp4\u00005\u0000123"]: { id: "upload-4", offset: 0 } }));
  let failed = true;
  const upload = new ResumableMediaUpload({
    storage,
    fetchImpl: async (url, init = {}) => {
      if (!init.method || init.method === "GET") {
        if (failed) { failed = false; throw new Error("GET caiu"); }
        return response({ offset: 0, tamanhoTotal: 5, tamanhoParte: 5, estado: "uploading" });
      }
      if (init.method === "PATCH") return response({ mediaId: "f".repeat(64), deduplicado: false }, 201);
      throw new Error(`chamada inesperada: ${url}`);
    },
  });
  await expect(upload.start(file())).rejects.toThrow("GET caiu");
  expect(upload.state).toBe("parado");
  await upload.start(file());
  expect(upload.state).toBe("concluido");
});

it("expõe o status HTTP do erro do servidor para a interface escolher a mensagem", async () => {
  const memory = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  };
  const tooBig = new ResumableMediaUpload({
    storage: memory(),
    fetchImpl: async () => response({ error: "mídia acima do tamanho máximo" }, 413),
  });
  await expect(tooBig.start(file())).rejects.toMatchObject({ status: 413, message: "mídia acima do tamanho máximo" });

  const invalid = new ResumableMediaUpload({
    storage: memory(),
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") return response({ id: "upload-5", offset: 0, tamanhoParte: 5 }, 201);
      if (init.method === "PATCH") return response({ error: "mídia ilegível" }, 422);
      throw new Error(`chamada inesperada: ${url}`);
    },
  });
  await expect(invalid.start(file())).rejects.toMatchObject({ status: 422 });
});

it("envia bytes direto ao R2 e só conclui depois da importação na VPS", async () => {
  const calls = [];
  const progress = [];
  let parts = 0;
  const upload = new ResumableMediaUpload({
    storage: { getItem: () => null, setItem: () => {} }, onProgress: value => progress.push(value),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, ...init });
      if (url === "/api/uploads") return response({ id: "r2-1", transporte: "r2", offset: 0, tamanhoParte: 3 }, 201);
      if (url.endsWith("/parts")) return response({ url: `https://r2.example/part-${++parts}` });
      if (url.startsWith("https://r2.example/")) return new Response(null);
      if (url.endsWith("/complete")) return response({ estado: "importing" }, 202);
      if (url === "/api/uploads/r2-1") return response({ mediaId: "e".repeat(64), deduplicado: false });
      throw new Error(`chamada inesperada: ${url}`);
    },
  });
  expect(await upload.start(file())).toMatchObject({ mediaId: "e".repeat(64) });
  const puts = calls.filter(call => call.method === "PUT");
  expect(puts.map(call => call.body.byteLength)).toEqual([3, 2]);
  expect(puts.every(call => call.credentials === "omit")).toBe(true);
  expect(calls.some(call => call.method === "PATCH")).toBe(false);
  expect(progress.map(value => value.state)).toContain("importing");
  expect(progress.at(-1).state).toBe("ready");
});

it("retoma R2 do offset confirmado no servidor após uma parte interrompida", async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const uploaded = [];
  let failed = false;
  const upload = new ResumableMediaUpload({ storage, fetchImpl: async (url, init = {}) => {
    if (url === "/api/uploads") return response({ id: "r2-2", transporte: "r2", offset: 0, tamanhoParte: 3 }, 201);
    if (url.endsWith("/parts")) return response({ url: `https://r2.example/${JSON.parse(init.body).numero}` });
    if (url.startsWith("https://r2.example/")) {
      if (url.endsWith("/2") && !failed) { failed = true; throw new Error("rede caiu"); }
      uploaded.push(url); return new Response(null);
    }
    if (url.endsWith("/complete")) return response({ mediaId: "e".repeat(64) });
    if (url === "/api/uploads/r2-2") return response({ transporte: "r2", offset: 3, tamanhoParte: 3, estado: "uploading" });
    throw new Error(`chamada inesperada: ${url}`);
  } });
  await expect(upload.start(file())).rejects.toThrow("rede caiu");
  expect(upload.state).toBe("parado");
  await upload.start(file());
  expect(uploaded).toEqual(["https://r2.example/1", "https://r2.example/2"]);
});

it("uma sessão R2 importando é acompanhada sem reenviar ou concluir as partes", async () => {
  const storage = { getItem: () => JSON.stringify({ ["aula.mp4\u00005\u0000123"]: { id: "r2-3", offset: 5 } }), setItem: () => {} };
  let reads = 0;
  const upload = new ResumableMediaUpload({ storage, fetchImpl: async (_url, init = {}) => {
    expect(init.method ?? "GET").toBe("GET");
    return response(++reads === 1 ? { transporte: "r2", estado: "importing", offset: 5 } : { mediaId: "e".repeat(64) });
  } });
  expect(await upload.start(file())).toHaveProperty("mediaId");
});

it("mantém a sessão salva quando o servidor está indisponível", async () => {
  const storage = { getItem: () => JSON.stringify({ ["aula.mp4\u00005\u0000123"]: { id: "r2-4" } }), setItem: () => {} };
  const upload = new ResumableMediaUpload({ storage, fetchImpl: async () => response({ error: "R2 indisponível" }, 503) });
  await expect(upload.start(file())).rejects.toMatchObject({ status: 503 });
});
