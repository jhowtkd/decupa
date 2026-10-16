/** Importação direta do Google Drive: a VPS baixa com API key um arquivo
 *  compartilhado como "qualquer pessoa com o link". O runtime mantém
 *  retomada, validação e recibos; o adaptador só acessa o Drive. */

export class DriveHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
}

type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const BASE = "https://www.googleapis.com/drive/v3";
const BARE_ID = /^[A-Za-z0-9_-]{10,}$/;
const EXTRACTED_ID = /^[A-Za-z0-9_-]+$/;
const NATIVE_DOC = "documentos do Google (Docs, Planilhas, Apresentações) não podem ser importados; exporte como vídeo ou áudio";

export function parseDriveFileId(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new DriveHttpError(400, "cole o link do arquivo no Google Drive");
  }
  const value = input.trim();
  if (BARE_ID.test(value)) return value;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DriveHttpError(400, "link do Drive inválido"); }
  if (url.hostname === "docs.google.com") throw new DriveHttpError(400, NATIVE_DOC);
  if (url.hostname !== "drive.google.com") throw new DriveHttpError(400, "link do Drive inválido");
  if (url.pathname.includes("/folders/")) {
    throw new DriveHttpError(400, "pastas do Drive não são suportadas; abra o arquivo e copie o link dele");
  }
  const match = /\/file\/d\/([^/]+)/.exec(url.pathname);
  const id = match?.[1] ?? url.searchParams.get("id");
  if (!id || !EXTRACTED_ID.test(id)) {
    throw new DriveHttpError(400, "não encontrei o arquivo neste link; abra o arquivo e copie o link de compartilhamento");
  }
  return id;
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
    `${BASE}/files/${encodeURIComponent(fileId)}?${query}&key=${encodeURIComponent(key)}`;
  return {
    async metadata(fileId: string): Promise<DriveFile> {
      const response = await fetchImpl(fileUrl(fileId, "fields=id,name,mimeType,size,md5Checksum"), {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) await throwDriveError(response, "não foi possível ler o arquivo no Drive");
      const body = await response.json() as { name?: unknown; mimeType?: unknown; size?: unknown; md5Checksum?: unknown };
      const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
      if (mimeType.startsWith("application/vnd.google-apps.")) throw new DriveHttpError(400, NATIVE_DOC);
      const tamanho = Number(body.size);
      if (body.size === undefined || !Number.isSafeInteger(tamanho) || tamanho < 0) {
        throw new DriveHttpError(400, "o Drive não informou o tamanho do arquivo");
      }
      const nome = typeof body.name === "string" && body.name !== "" ? body.name : "drive-import";
      const md5 = typeof body.md5Checksum === "string" && /^[0-9a-f]{32}$/i.test(body.md5Checksum)
        ? body.md5Checksum.toLowerCase()
        : undefined;
      return { id: fileId, nome, tamanho, md5, mimeType };
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
  };
}
