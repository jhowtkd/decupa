import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startApp } from "./server.ts";

function rawRequest(
  port: number,
  opts: { path: string; method?: string; headers?: Record<string, string | number>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: opts.path,
      method: opts.method ?? "GET",
      headers: opts.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.setTimeout(4_000, () => {
      req.destroy(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("URL malformada na limpeza", () => {
  it("GET // responde 400 e a limpeza continua respondendo", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "decupa-bad-url-"));
    const app = await startApp({ input: join(tmp, "v.mp4"), port: 0, autoStart: false });
    try {
      const bad = await rawRequest(app.port, { path: "//" });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body)).toEqual({ error: "URL inválida" });
      const home = await rawRequest(app.port, { path: "/" });
      expect(home.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
