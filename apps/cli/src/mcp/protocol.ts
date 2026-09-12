export type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function encodeFrame(message: object): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

export class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpc[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: JsonRpc[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + length) break;
      const json = this.buf.subarray(start, start + length).toString("utf8");
      this.buf = this.buf.subarray(start + length);
      out.push(JSON.parse(json) as JsonRpc);
    }
    return out;
  }
}

export function rpcResult(id: JsonRpc["id"], result: unknown): JsonRpc {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(id: JsonRpc["id"], message: string, code = -32000): JsonRpc {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
