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
