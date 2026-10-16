import { createServer } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { createR2Staging } from "./r2-staging.ts";

const env = {
  DECUPA_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  DECUPA_R2_BUCKET: "decupa-staging",
  DECUPA_R2_ACCESS_KEY_ID: "fixture-access",
  DECUPA_R2_SECRET_ACCESS_KEY: "fixture-secret",
};

it("só habilita R2 com configuração completa e rejeita endpoints arbitrários", () => {
  expect(createR2Staging({})).toBeUndefined();
  expect(() => createR2Staging({ DECUPA_R2_BUCKET: "bucket" })).toThrow(/R2/);
  expect(() => createR2Staging({ ...env, DECUPA_R2_ACCOUNT_ID: "localhost:3000" })).toThrow(/R2/);
});

it("assina apenas a parte solicitada, com expiração e sem revelar a chave secreta", async () => {
  const r2 = createR2Staging(env)!;
  const url = new URL(await r2.signPart("decupa-staging/id", "multipart-id", 2));
  expect(url.hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);
  expect(url.pathname).toContain("decupa-staging/id");
  expect(url.searchParams.get("partNumber")).toBe("2");
  expect(url.searchParams.get("uploadId")).toBe("multipart-id");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(url.href).not.toContain("fixture-secret");
});

it("lê todas as páginas de partes e distingue objeto ausente de acesso negado", async () => {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push(url);
    if (req.method === "HEAD") {
      res.writeHead(url.pathname.endsWith("denied") ? 403 : 404); res.end(); return;
    }
    const second = url.searchParams.get("part-number-marker") === "1";
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<ListPartsResult><IsTruncated>${!second}</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>${second ? 2 : 1}</PartNumber><ETag>"etag-${second ? 2 : 1}"</ETag><Size>${second ? 3 : 5242880}</Size></Part></ListPartsResult>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, region: "auto", forcePathStyle: true, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" }, maxAttempts: 1 });
  try {
    const r2 = createR2Staging(env, client)!;
    expect(await r2.parts("key", "upload")).toEqual([{ number: 1, etag: '"etag-1"', size: 5242880 }, { number: 2, etag: '"etag-2"', size: 3 }]);
    expect(requests).toHaveLength(2);
    expect(await r2.head("missing")).toBeNull();
    await expect(r2.head("denied")).rejects.toThrow();
  } finally {
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("cancela uma leitura HTTP parada depois de receber os headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": "100", etag: '"object"' });
    res.write("x");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, region: "auto", forcePathStyle: true, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" }, maxAttempts: 1 });
  const controller = new AbortController();
  let started!: () => void;
  const firstByte = new Promise<void>(resolve => { started = resolve; });
  const reading = (async () => {
    for await (const _chunk of createR2Staging(env, client)!.read("key", '"object"', controller.signal)) started();
  })();
  // Registra o handler imediatamente para evitar rejeição não observada.
  const outcome = reading.then(() => "terminou", () => "cancelou");
  try {
    await firstByte;
    controller.abort();
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("bloqueado"), 300))])).toBe("cancelou");
  } finally {
    client.destroy();
    server.closeAllConnections();
    await outcome;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
