import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRange, serveMedia } from "./media.ts";

describe("parseRange", () => {
  it("devolve null sem cabeçalho", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it("lê um intervalo fechado", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
  });

  it("completa o fim quando omitido", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("interpreta sufixo como os últimos N bytes", () => {
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("limita o fim ao último byte disponível", () => {
    expect(parseRange("bytes=0-99999", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("devolve null quando o início passa do tamanho", () => {
    expect(parseRange("bytes=1000-1500", 1000)).toBeNull();
  });

  it("devolve null quando o fim vem antes do início", () => {
    expect(parseRange("bytes=500-100", 1000)).toBeNull();
  });

  it("devolve null para cabeçalho malformado", () => {
    expect(parseRange("bytes=abc", 1000)).toBeNull();
    expect(parseRange("items=0-10", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
  });

  it("tolera espaço em volta", () => {
    expect(parseRange("  bytes=10-20  ", 1000)).toEqual({ start: 10, end: 20 });
  });
});

describe("serveMedia", () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => { await stop?.(); stop = null; });

  async function boot(path: string): Promise<string> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      serveMedia(req, res, path).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    stop = () => new Promise((resolve) => { server.close(() => resolve()); });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("serve o arquivo inteiro com Accept-Ranges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-media-"));
    const path = join(dir, "v.mp4");
    await writeFile(path, Buffer.alloc(2048, 7));
    const base = await boot(path);
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toMatch(/video\/mp4/);
    expect((await res.arrayBuffer()).byteLength).toBe(2048);
  });

  it("honra Range e devolve 206", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-media-"));
    const path = join(dir, "v.mp4");
    await writeFile(path, Buffer.from("abcdefghijklmnopqrstuvwxyz"));
    const base = await boot(path);
    const res = await fetch(base, { headers: { Range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/26");
    expect(await res.text()).toBe("abcd");
  });
});
