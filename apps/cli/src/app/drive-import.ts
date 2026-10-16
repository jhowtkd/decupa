/** Importação direta do Google Drive: a VPS baixa com API key um arquivo
 *  compartilhado como "qualquer pessoa com o link". O runtime mantém
 *  retomada, validação e recibos; o adaptador só acessa o Drive. */

export class DriveHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DriveFile {
  id: string;
  nome: string;
  tamanho: number;
  md5?: string;
  mimeType: string;
}

export interface DriveReadResult {
  /** Verdadeiro quando o Drive ignorou o Range e mandou do começo. */
  restarted: boolean;
  total: number;
  body: AsyncIterable<Uint8Array>;
}

export interface DriveImport {
  metadata(fileId: string): Promise<DriveFile>;
  read(fileId: string, start: number, total: number, signal?: AbortSignal): Promise<DriveReadResult>;
  listMedia(folderId: string): Promise<{ items: DriveChild[]; ignorados: number }>;
}

export interface DriveChild {
  id: string;
  nome: string;
  tamanho: number;
  md5?: string;
}

export interface DriveUrl {
  kind: "file" | "folder";
  id: string;
}

type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const BASE = "https://www.googleapis.com/drive/v3";
const BARE_ID = /^[A-Za-z0-9_-]{10,}$/;
const EXTRACTED_ID = /^[A-Za-z0-9_-]+$/;
const NATIVE_DOC = "documentos do Google (Docs, Planilhas, Apresentações) não podem ser importados; exporte como vídeo ou áudio";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_PASTA_ITENS = 50;
const MAX_PASTA_PROFUNDIDADE = 5;
const MAX_PASTA_VARREDURA = 500;
const MIDIA_EXTENSOES = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mts", "m2ts", "mpg", "mpeg", "3gp", "flv", "wmv",
  "mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac", "wma", "aiff", "aif",
]);

function validMd5(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value) ? value.toLowerCase() : undefined;
}

function isMedia(mimeType: string, nome: string): boolean {
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) return true;
  if (mimeType === "application/octet-stream") return true;
  const ext = /\.([a-z0-9]+)$/i.exec(nome)?.[1]?.toLowerCase();
  return !!ext && MIDIA_EXTENSOES.has(ext);
}

export function parseDriveUrl(input: unknown): DriveUrl {
  if (typeof input !== "string" || input.trim() === "") {
    throw new DriveHttpError(400, "cole o link do arquivo no Google Drive");
  }
  const value = input.trim();
  if (BARE_ID.test(value)) return { kind: "file", id: value };
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DriveHttpError(400, "link do Drive inválido"); }
  if (url.hostname === "docs.google.com") throw new DriveHttpError(400, NATIVE_DOC);
  if (url.hostname !== "drive.google.com") throw new DriveHttpError(400, "link do Drive inválido");
  const folder = /\/folders\/([^/?#]+)/.exec(url.pathname);
  if (folder?.[1] && EXTRACTED_ID.test(folder[1])) return { kind: "folder", id: folder[1] };
  const match = /\/file\/d\/([^/]+)/.exec(url.pathname);
  const id = match?.[1] ?? url.searchParams.get("id");
  if (!id || !EXTRACTED_ID.test(id)) {
    throw new DriveHttpError(400, "não encontrei o arquivo neste link; abra o arquivo e copie o link de compartilhamento");
  }
  return { kind: "file", id };
}

export function parseDriveFileId(input: unknown): string {
  const parsed = parseDriveUrl(input);
  if (parsed.kind === "folder") {
    throw new DriveHttpError(400, "este link é de uma pasta do Drive; informe o link de um arquivo");
  }
  return parsed.id;
}

async function throwDriveError(response: Response, fallback: string): Promise<never> {
  let reason = "";
  try {
    const body = await response.json() as { error?: { errors?: { reason?: string }[] } };
    reason = body.error?.errors?.[0]?.reason ?? "";
  } catch { /* corpo não-JSON: decide pelo status */ }
  if (reason === "API_KEY_INVALID" || reason === "API_KEY_SERVICE_BLOCKED") {
    throw new DriveHttpError(503, "chave da API do Drive inválida; confira DECUPA_DRIVE_API_KEY na VPS");
  }
  if (["dailyLimitExceeded", "quotaExceeded", "rateLimitExceeded", "downloadQuotaExceeded", "userRateLimitExceeded"].includes(reason)) {
    throw new DriveHttpError(503, "cota do Google Drive excedida; tente de novo mais tarde");
  }
  if (response.status === 404) throw new DriveHttpError(404, "arquivo não encontrado no Drive ou sem link público");
  if (response.status === 403) throw new DriveHttpError(403, "o Google recusou o acesso (permissão ou cota)");
  if (response.status === 400) throw new DriveHttpError(400, "o Google recusou este arquivo; confira o link e a chave da API");
  throw new DriveHttpError(502, fallback);
}

export function createDriveImport(
  env: Record<string, string | undefined>,
  fetchImpl: FetchImpl = globalThis.fetch,
): DriveImport | undefined {
  const key = env.DECUPA_DRIVE_API_KEY?.trim();
  if (!key) return undefined;
  const fileUrl = (fileId: string, query: string) =>
    `${BASE}/files/${encodeURIComponent(fileId)}?${query}&supportsAllDrives=true&key=${encodeURIComponent(key)}`;
  return {
    async metadata(fileId: string): Promise<DriveFile> {
      const response = await fetchImpl(fileUrl(fileId, "fields=id,name,mimeType,size,md5Checksum"), {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) await throwDriveError(response, "não foi possível ler o arquivo no Drive");
      const body = await response.json() as { name?: unknown; mimeType?: unknown; size?: unknown; md5Checksum?: unknown };
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
      if (mimeType === FOLDER) {
        throw new DriveHttpError(400, "este ID é de uma pasta; cole o link da pasta para importar os arquivos", "FOLDER_ID");
      }
      if (mimeType.startsWith("application/vnd.google-apps.")) throw new DriveHttpError(400, NATIVE_DOC);
      const tamanho = Number(body.size);
      if (body.size === undefined || !Number.isSafeInteger(tamanho) || tamanho < 0) {
        throw new DriveHttpError(400, "o Drive não informou o tamanho do arquivo");
      }
      const nome = typeof body.name === "string" && body.name !== "" ? body.name : "drive-import";
      return { id: fileId, nome, tamanho, md5: validMd5(body.md5Checksum), mimeType };
    },
    async read(fileId: string, start: number, total: number, signal?: AbortSignal): Promise<DriveReadResult> {
      const response = await fetchImpl(fileUrl(fileId, "alt=media"), {
        headers: start > 0 ? { Range: `bytes=${start}-` } : undefined,
        signal,
      });
      if (!response.ok) await throwDriveError(response, "não foi possível baixar do Drive");
      if (!response.body) throw new DriveHttpError(502, "o Drive retornou o download sem corpo");
      const body = response.body as unknown as AsyncIterable<Uint8Array>;
      if (start > 0 && response.status !== 206) return { restarted: true, total, body };
      if (response.status === 206) {
        const match = /^bytes [0-9]+-[0-9]+\/([0-9]+)$/.exec(response.headers.get("content-range") ?? "");
        const remote = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(remote) || remote !== total) {
          throw new DriveHttpError(422, "o arquivo no Drive mudou durante a importação");
        }
      }
      return { restarted: false, total, body };
    },
    async listMedia(folderId: string): Promise<{ items: DriveChild[]; ignorados: number }> {
      const items: DriveChild[] = [];
      let ignorados = 0;
      let scanned = 0;
      const visit = async (id: string, depth: number): Promise<void> => {
        let pageToken: string | undefined;
        do {
          if (scanned >= MAX_PASTA_VARREDURA) {
            throw new DriveHttpError(400, "pasta do Drive grande demais para importar de uma vez");
          }
          const params = new URLSearchParams({
            q: `'${id}' in parents and trashed = false`,
            fields: "files(id,name,mimeType,size,md5Checksum),nextPageToken",
            pageSize: "100",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            key,
          });
          if (pageToken) params.set("pageToken", pageToken);
          const response = await fetchImpl(`${BASE}/files?${params}`, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) await throwDriveError(response, "não foi possível listar a pasta no Drive");
          const body = await response.json() as {
            files?: { id?: unknown; name?: unknown; mimeType?: unknown; size?: unknown; md5Checksum?: unknown }[];
            nextPageToken?: unknown;
          };
          for (const entry of body.files ?? []) {
            scanned += 1;
            if (typeof entry.id !== "string" || !EXTRACTED_ID.test(entry.id)) { ignorados += 1; continue; }
            const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "";
            const nome = typeof entry.name === "string" && entry.name !== "" ? entry.name : "drive-import";
            if (mimeType === FOLDER) {
              if (depth < MAX_PASTA_PROFUNDIDADE) await visit(entry.id, depth + 1);
              continue;
            }
            const tamanho = Number(entry.size);
            if (mimeType.startsWith("application/vnd.google-apps.") || !Number.isSafeInteger(tamanho) || tamanho <= 0) {
              ignorados += 1;
              continue;
            }
            if (!isMedia(mimeType, nome)) { ignorados += 1; continue; }
            items.push({ id: entry.id, nome, tamanho, md5: validMd5(entry.md5Checksum) });
            if (items.length > MAX_PASTA_ITENS) {
              throw new DriveHttpError(400, "a pasta tem mídias demais para uma importação (máximo 50)");
            }
          }
          pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
        } while (pageToken);
      };
      await visit(folderId, 0);
      return { items, ignorados };
    },
  };
}
