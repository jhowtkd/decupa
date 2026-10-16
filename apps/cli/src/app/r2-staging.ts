import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListPartsCommand, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StagingPart { number: number; size: number; etag: string }
export interface StagingObject { size: number; etag: string }

/** O runtime mantém identidade, validação e recibos; o adaptador só acessa R2. */
export interface R2Staging {
  create(key: string): Promise<string>;
  signPart(key: string, upload: string, number: number): Promise<string>;
  parts(key: string, upload: string): Promise<StagingPart[]>;
  complete(key: string, upload: string, parts: StagingPart[]): Promise<void>;
  head(key: string): Promise<StagingObject | null>;
  read(key: string, etag: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  delete(key: string): Promise<void>;
  abort(key: string, upload: string): Promise<void>;
  close?(): void;
}

function notFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.$metadata?.httpStatusCode === 404 || value.name === "NoSuchUpload";
}

export function createR2Staging(env: Record<string, string | undefined>, client?: S3Client): R2Staging | undefined {
  const values = [env.DECUPA_R2_ACCOUNT_ID, env.DECUPA_R2_BUCKET, env.DECUPA_R2_ACCESS_KEY_ID, env.DECUPA_R2_SECRET_ACCESS_KEY];
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value) || !/^[a-f0-9]{32}$/i.test(values[0]!)) {
    throw new Error("R2 exige DECUPA_R2_ACCOUNT_ID válido, DECUPA_R2_BUCKET, DECUPA_R2_ACCESS_KEY_ID e DECUPA_R2_SECRET_ACCESS_KEY");
  }
  const [account, bucket, accessKeyId, secretAccessKey] = values as [string, string, string, string];
  const s3 = client ?? new S3Client({
    region: "auto", endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // R2 usa a integridade do transporte. Não exigir checksums AWS opcionais.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 10_000, socketTimeout: 60_000 },
  });
  const object = (key: string) => ({ Bucket: bucket, Key: key });
  const deadline = () => ({ abortSignal: AbortSignal.timeout(30_000) });
  return {
    async create(key) {
      const result = await s3.send(new CreateMultipartUploadCommand({ ...object(key), ContentType: "application/octet-stream" }), deadline());
      if (!result.UploadId) throw new Error("R2 não retornou o identificador do envio");
      return result.UploadId;
    },
    signPart: (key, upload, number) => getSignedUrl(s3, new UploadPartCommand({ ...object(key), UploadId: upload, PartNumber: number }), { expiresIn: 900 }),
    async parts(key, upload) {
      const parts: StagingPart[] = [];
      let marker: string | undefined;
      do {
        const page = await s3.send(new ListPartsCommand({ ...object(key), UploadId: upload, PartNumberMarker: marker }), deadline());
        for (const part of page.Parts ?? []) {
          if (!part.PartNumber || part.Size === undefined || !part.ETag) throw new Error("parte R2 inválida");
          parts.push({ number: part.PartNumber, size: part.Size, etag: part.ETag });
        }
        const next = page.IsTruncated ? page.NextPartNumberMarker : undefined;
        if (page.IsTruncated && (!next || next === marker)) throw new Error("paginação R2 inválida");
        marker = next;
      } while (marker);
      return parts.sort((a, b) => a.number - b.number);
    },
    async complete(key, upload, parts) {
      await s3.send(new CompleteMultipartUploadCommand({ ...object(key), UploadId: upload, MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.number, ETag: part.etag })) } }), deadline());
    },
    async head(key) {
      try {
        const result = await s3.send(new HeadObjectCommand(object(key)), deadline());
        if (result.ContentLength === undefined || !result.ETag) throw new Error("objeto R2 inválido");
        return { size: result.ContentLength, etag: result.ETag };
      } catch (error) { if (notFound(error)) return null; throw error; }
    },
    async *read(key, etag, signal) {
      const result = await s3.send(new GetObjectCommand({ ...object(key), IfMatch: etag }), { abortSignal: signal });
      if (!result.Body) throw new Error("objeto R2 sem corpo");
      yield* result.Body as AsyncIterable<Uint8Array>;
    },
    async delete(key) { await s3.send(new DeleteObjectCommand(object(key)), deadline()); },
    async abort(key, upload) {
      try { await s3.send(new AbortMultipartUploadCommand({ ...object(key), UploadId: upload }), deadline()); }
      catch (error) { if (!notFound(error)) throw error; }
    },
    close: () => s3.destroy(),
  };
}
