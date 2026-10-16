import { expect, it } from "vitest";
import { createDriveImport, DriveHttpError, parseDriveFileId } from "./drive-import.ts";

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
  expect(() => parseDriveFileId(`https://drive.google.com/drive/folders/${ID}`)).toThrowError(/pastas do Drive/);
  expect(() => parseDriveFileId("https://example.com/arquivo.mp4")).toThrowError(/inválido/);
  expect(() => parseDriveFileId("curto")).toThrowError(/inválido/);
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

it("propaga o cancelamento sem mascarar como falha", async () => {
  const { fetchImpl } = driveFetch(() => { throw new DOMException("aborted", "AbortError"); });
  const drive = createDriveImport({ DECUPA_DRIVE_API_KEY: "chave-1" }, fetchImpl)!;
  const controller = new AbortController();
  controller.abort();
  await expect(drive.read(ID, 0, 12, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
