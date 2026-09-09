import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SAMPLE_RATE, probe, readPcm } from "@decupa/media";
import { serveMedia } from "../http/media.ts";
import { originAllowed } from "../http/origin.ts";
import { computePeaks } from "./peaks.ts";
import { ensureProxy } from "./proxy.ts";

export { parseRange } from "../http/media.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUCKETS_PER_SECOND = 200;

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
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
  /** Avisa em que porta o bind caiu — com `port: 0` só o servidor sabe, e o
   * retorno só resolve depois de a página salvar. */
  onListen?: (port: number) => void;
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
    // `port: 0` pede porta efêmera: o portão de origem precisa da que o bind
    // escolheu, e o listen abaixo atualiza isso antes de aceitar conexões.
    let boundPort = opts.port ?? 7777;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      const handle = async (): Promise<void> => {
        // Mesmo portão do app limpar: bind em 127.0.0.1 protege da rede, não
        // do navegador — e aqui o POST sobrescreve o truth-file da medição.
        if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort)) {
          sendJson(res, { error: "origem não permitida" }, 403);
          return;
        }
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
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 7777);
      boundPort = port;
      opts.onListen?.(port);
      console.log(`marcador aberto em http://127.0.0.1:${port}`);
      console.log("marque as fronteiras e clique em Salvar — o terminal fecha sozinho");
    });
  });
}
