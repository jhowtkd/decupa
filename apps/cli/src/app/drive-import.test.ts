import { expect, it } from "vitest";
import { createDriveImport, DriveHttpError, parseDriveFileId, parseDriveUrl } from "./drive-import.ts";

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

it("aceita o id puro, com espaços ao redor", () => {
  expect(parseDriveFileId(`  ${ID}  `)).toBe(ID);
});

it("extrai o id dos formatos de link do Drive", () => {
  expect(parseDriveFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`)).toBe(ID);
  expect(parseDriveFileId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
  expect(parseDriveFileId(`https://drive.google.com/uc?id=${ID}&export=download`)).toBe(ID);
});

it("recusa entrada vazia, pasta e link estranho com mensagens próprias", () => {
  for (const input of ["", "   ", undefined, 42]) {
    expect(() => parseDriveFileId(input), JSON.stringify(input)).toThrowError(DriveHttpError);
  }
  try { parseDriveFileId(""); expect.unreachable(); }
  catch (error) { expect((error as DriveHttpError).status).toBe(400); }
  expect(() => parseDriveFileId(`https://drive.google.com/drive/folders/${ID}`)).toThrowError(/pasta do Drive/);
  expect(() => parseDriveFileId("https://example.com/arquivo.mp4")).toThrowError(/inválido/);
  expect(() => parseDriveFileId("curto")).toThrowError(/inválido/);
});

it("distingue link de arquivo e de pasta", () => {
  expect(parseDriveUrl(`https://drive.google.com/file/d/${ID}/view`)).toEqual({ kind: "file", id: ID });
  expect(parseDriveUrl(ID)).toEqual({ kind: "file", id: ID });
  expect(parseDriveUrl(`https://drive.google.com/drive/folders/${ID}`)).toEqual({ kind: "folder", id: ID });
  expect(parseDriveUrl(`https://drive.google.com/drive/u/0/folders/${ID}`)).toEqual({ kind: "folder", id: ID });
});

it("recusa documento nativo do Google já no link", () => {
  expect(() => parseDriveFileId(`https://docs.google.com/document/d/${ID}/edit`)).toThrowError(/exporte como vídeo ou áudio/);
});

it("sem chave não há importação do Drive", () => {
  expect(createDriveImport({})).toBeUndefined();
  expect(createDriveImport({ DECUPA_DRIVE_API_KEY: "   " })).toBeUndefined();
});

function driveFetch(handle: (url: URL, init: { headers?: Record<string, string> }) => Response) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    return handle(new URL(url), { headers: init?.headers });
  };
  return { calls, fetchImpl };
}

function metadataBody(extra = {}) {
  return { id: ID, name: "aula.mp4", mimeType: "video/mp4", size: "12", md5Checksum: "d41d8cd98f00b204e9800998ecf8427e", ...extra };
}

it("lê os metadados com a chave na URL", async () => {
  const { calls, fetchImpl } = driveFetch(() => Response.json(metadataBody()));
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const file = await drive.metadata(ID);
  expect(file).toEqual({ id: ID, nome: "aula.mp4", tamanho: 12, md5: "d41d8cd98f00b204e9800998ecf8427e", mimeType: "video/mp4" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain(`files/${ID}?`);
  expect(calls[0]).toContain("key=chave-1");
  expect(calls[0]).toContain("fields=");
  // Sem este parâmetro, arquivo de drive compartilhado responde 404.
  expect(calls[0]).toContain("supportsAllDrives=true");
});

it("ID de pasta nos metadados avisa com código próprio", async () => {
  const { fetchImpl } = driveFetch(() => Response.json({ id: ID, name: "pasta", mimeType: "application/vnd.google-apps.folder" }));
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const error = await drive.metadata(ID).catch(error => error);
  expect(error).toMatchObject({ status: 400, code: "FOLDER_ID" });
});

it("mapeia não-encontrado, cota e chave inválida", async () => {
  const drive = (body: unknown, status: number) => {
    const { fetchImpl } = driveFetch(() => Response.json(body, { status }));
    return createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  };
  await expect(drive({ error: { errors: [{ reason: "notFound" }] } }, 404).metadata(ID))
    .rejects.toMatchObject({ status: 404, message: expect.stringContaining("sem link público") });
  await expect(drive({ error: { errors: [{ reason: "downloadQuotaExceeded" }] } }, 403).metadata(ID))
    .rejects.toMatchObject({ status: 503, message: expect.stringContaining("cota") });
  await expect(drive({ error: { errors: [{ reason: "API_KEY_INVALID" }] } }, 400).metadata(ID))
    .rejects.toMatchObject({ status: 503, message: expect.stringContaining("DECUPA_DRIVE_API_KEY") });
  await expect(drive({ error: { errors: [{ reason: "authError" }] } }, 403).metadata(ID))
    .rejects.toMatchObject({ status: 403 });
});

it("recusa documento nativo e tamanho ausente nos metadados", async () => {
  const { fetchImpl } = driveFetch(() => Response.json(metadataBody({ mimeType: "application/vnd.google-apps.document", size: undefined, md5Checksum: undefined })));
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  await expect(drive.metadata(ID)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("exporte como vídeo ou áudio") });
  const { fetchImpl: semTamanho } = driveFetch(() => Response.json(metadataBody({ size: undefined })));
  const drive2 = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, semTamanho)!;
  await expect(drive2.metadata(ID)).rejects.toMatchObject({ status: 400 });
});

it("baixa do começo sem Range e retoma com Range", async () => {
  const seen: (Record<string, string> | undefined)[] = [];
  const { fetchImpl } = driveFetch((_url, init) => {
    seen.push(init.headers);
    return new Response("0123456789ab", { status: init.headers ? 206 : 200, headers: init.headers ? { "content-range": "bytes 4-11/12" } : {} });
  });
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const full = await drive.read(ID, 0, 12);
  expect(full.restarted).toBe(false);
  expect(seen[0]).toBeUndefined();
  const resumed = await drive.read(ID, 4, 12);
  expect(resumed.restarted).toBe(false);
  expect(seen[1]).toEqual({ Range: "bytes=4-" });
  let bytes = 0;
  for await (const chunk of resumed.body) bytes += chunk.byteLength;
  expect(bytes).toBe(12);
});

it("quando o Drive ignora o Range, sinaliza recomeço", async () => {
  const { fetchImpl } = driveFetch(() => new Response("0123456789ab", { status: 200 }));
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const result = await drive.read(ID, 4, 12);
  expect(result.restarted).toBe(true);
});

it("quando o total muda no meio, falha a validação", async () => {
  const { fetchImpl } = driveFetch(() => new Response("xyz", { status: 206, headers: { "content-range": "bytes 0-2/99" } }));
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  await expect(drive.read(ID, 0, 12)).rejects.toMatchObject({ status: 422 });
});

it("lista mídias da pasta com paginação, recursão e filtro", async () => {
  const seen: string[] = [];
  const pages: Record<string, unknown> = {
    "root:": {
      files: [
        { id: "a".repeat(28), name: "aula.mp4", mimeType: "video/mp4", size: "100", md5Checksum: "d41d8cd98f00b204e9800998ecf8427e" },
        { id: "b".repeat(28), name: "notas.txt", mimeType: "text/plain", size: "10" },
        { id: "c".repeat(28), name: "doc", mimeType: "application/vnd.google-apps.document" },
        { id: "d".repeat(28), name: "sub", mimeType: "application/vnd.google-apps.folder" },
        { id: "e".repeat(28), name: "vazio.mp4", mimeType: "video/mp4", size: "0" },
      ],
      nextPageToken: "p2",
    },
    "root:p2": {
      files: [{ id: "f".repeat(28), name: "gravacao.mkv", mimeType: "application/octet-stream", size: "200" }],
    },
    [`${"d".repeat(28)}:`]: {
      files: [{ id: "g".repeat(28), name: "entrevista.m4a", mimeType: "audio/mp4", size: "50" }],
    },
  };
  const { fetchImpl } = driveFetch((url) => {
    seen.push(url.toString());
    const match = /'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "");
    const key = `${match?.[1]}:${url.searchParams.get("pageToken") ?? ""}`;
    return Response.json(pages[key] ?? { files: [] });
  });
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const result = await drive.listMedia("root");
  expect(result.items.map(item => item.nome)).toEqual(["aula.mp4", "entrevista.m4a", "gravacao.mkv"]);
  expect(result.items[0]).toMatchObject({ id: "a".repeat(28), tamanho: 100, md5: "d41d8cd98f00b204e9800998ecf8427e" });
  expect(result.ignorados).toBe(3);
  for (const call of seen) {
    expect(call).toContain("supportsAllDrives=true");
    expect(call).toContain("includeItemsFromAllDrives=true");
  }
  expect(seen.some(call => call.includes("pageToken=p2"))).toBe(true);
});

it("pasta com mídias demais ou inacessível falha com mensagem", async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({
    id: String(i).padStart(28, "m"), name: `v${i}.mp4`, mimeType: "video/mp4", size: "10",
  }));
  const { fetchImpl } = driveFetch(() => Response.json({ files: many }));
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  await expect(drive.listMedia("root")).rejects.toMatchObject({ status: 400, message: expect.stringContaining("máximo 50") });
  const { fetchImpl: missing } = driveFetch(() => Response.json({ error: { errors: [{ reason: "notFound" }] } }, { status: 404 }));
  const drive2 = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, missing)!;
  await expect(drive2.listMedia("root")).rejects.toMatchObject({ status: 404 });
});

it("propaga o cancelamento sem mascarar como falha", async () => {
  const { fetchImpl } = driveFetch(() => { throw new DOMException("aborted", "AbortError"); });
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const controller = new AbortController();
  controller.abort();
  await expect(drive.read(ID, 0, 12, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
