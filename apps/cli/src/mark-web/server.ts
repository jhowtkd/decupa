import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SAMPLE_RATE, probe, readPcm } from "@decupa/media";
import { computePeaks } from "./peaks.ts";
import { ensureProxy } from "./proxy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUCKETS_PER_SECOND = 200;

export interface RangeSpec {
  start: number;
  end: number;
}

/**
 * Interpreta `Range: bytes=start-end`. Devolve null quando o cabeçalho está
 * ausente ou malformado — nesse caso o corpo inteiro é servido.
 * O `<video>` do navegador depende disso para buscar sem baixar tudo.
 */
export function parseRange(header: string | undefined, size: number): RangeSpec | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // "bytes=-500" = os últimos 500 bytes.
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return null;
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return null;
  return { start, end };
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const { size } = await stat(path);
  const range = parseRange(req.headers.range, size);

  if (!range) {
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": size,
      "accept-ranges": "bytes",
    });
    createReadStream(path).pipe(res);
    return;
  }

  res.writeHead(206, {
    "content-type": "video/mp4",
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
    "content-length": range.end - range.start + 1,
    "accept-ranges": "bytes",
  });
  createReadStream(path, { start: range.start, end: range.end }).pipe(res);
}

export interface MarkWebResult {
  boundariesMs: number[];
  outPath: string;
}

/**
 * Sobe o marcador web e resolve quando a página salvar.
 *
 * A página nunca recebe transcrição nem predição — só o vídeo e a forma de
 * onda, que são o sinal cru. Ver a onda é o que um editor sempre teve; ver a
 * resposta do alinhador é o que invalidaria a medição.
 */
export async function runMarkWeb(opts: {
  input: string;
  outPath: string;
  port?: number;
  cacheDir?: string;
}): Promise<MarkWebResult> {
  const cacheDir = opts.cacheDir ?? resolve("work/proxy");
  const info = await probe(opts.input);

  const [proxyPath, pcm, page] = await Promise.all([
    ensureProxy({ input: opts.input, cacheDir }),
    readPcm({ input: opts.input }),
    readFile(join(HERE, "page.html"), "utf8"),
  ]);

  const peaks = computePeaks(pcm, {
    sampleRate: DEFAULT_SAMPLE_RATE,
    bucketsPerSecond: BUCKETS_PER_SECOND,
  });
  const peaksPayload = {
    bucketsPerSecond: peaks.bucketsPerSecond,
    min: Array.from(peaks.min, (v) => Math.round(v * 1000) / 1000),
    max: Array.from(peaks.max, (v) => Math.round(v * 1000) / 1000),
  };

  return new Promise<MarkWebResult>((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      const handle = async (): Promise<void> => {
        if (url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(page);
          return;
        }
        if (url.pathname === "/meta") {
          sendJson(res, {
            name: basename(opts.input),
            durationMs: info.durationMs,
            outPath: opts.outPath,
          });
          return;
        }
        if (url.pathname === "/peaks") {
          sendJson(res, peaksPayload);
          return;
        }
        if (url.pathname === "/media") {
          await serveMedia(req, res, proxyPath);
          return;
        }
        if (url.pathname === "/truth" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            boundariesMs?: unknown;
          };
          const raw = body.boundariesMs;
          if (!Array.isArray(raw) || raw.some((v) => typeof v !== "number")) {
            sendJson(res, { error: "boundariesMs precisa ser number[]" }, 400);
            return;
          }
          const boundariesMs = [...new Set(raw as number[])]
            .map((v) => Math.round(v))
            .sort((a, b) => a - b);

          await writeFile(
            opts.outPath,
            `${JSON.stringify({
              boundariesMs,
              method: "blind-waveform",
              input: opts.input,
              durationMs: info.durationMs,
              markedAt: new Date().toISOString(),
            }, null, 2)}\n`,
            "utf8",
          );
          // Só encerrar depois que a resposta saiu. E `close()` sozinho não
          // basta: ele para de aceitar conexões novas mas deixa as keep-alive
          // do navegador abertas, e o processo fica pendurado segurando a porta.
          res.once("finish", () => {
            server.close();
            server.closeAllConnections();
            resolvePromise({ boundariesMs, outPath: opts.outPath });
          });
          sendJson(res, { ok: true, count: boundariesMs.length });
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("não encontrado");
      };

      handle().catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
      });
    });

    server.on("error", rejectPromise);
    server.listen(opts.port ?? 7777, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      console.log(`marcador aberto em http://127.0.0.1:${port}`);
      console.log("marque as fronteiras e clique em Salvar — o terminal fecha sozinho");
    });
  });
}
