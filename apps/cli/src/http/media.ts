import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

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

/** Serve o arquivo com `Accept-Ranges`, para o player buscar só o trecho. */
export async function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  contentType = "video/mp4",
): Promise<void> {
  const { size } = await stat(path);
  const range = parseRange(req.headers.range, size);

  if (!range) {
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": size,
      "accept-ranges": "bytes",
    });
    await pipeline(createReadStream(path), res);
    return;
  }

  res.writeHead(206, {
    "content-type": contentType,
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
    "content-length": range.end - range.start + 1,
    "accept-ranges": "bytes",
  });
  await pipeline(createReadStream(path, { start: range.start, end: range.end }), res);
}
