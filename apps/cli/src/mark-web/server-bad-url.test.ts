import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { runMarkWeb } from "./server.ts";

const TRUTH_BODY = "{\"boundariesMs\":[]}";

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

describe("URL malformada no marcador", () => {
  it("GET // responde 400 e o marcador continua respondendo", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "decupa-mark-url-"));
    let resolvePort: (port: number) => void = () => {};
    const done = runMarkWeb({
      input: join(FIXTURES, "clip.mp4"),
      outPath: join(tmp, "truth.json"),
      port: 0,
      cacheDir: join(tmp, "proxy"),
      onListen: (port) => resolvePort(port),
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("marcador não escutou")), 30_000);
      resolvePort = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      done.then(
        () => {
          clearTimeout(timer);
          reject(new Error("marcador encerrou antes de escutar"));
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

    const finish = async (): Promise<void> => {
      await rawRequest(port, {
        path: "/truth",
        method: "POST",
        headers: {
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(TRUTH_BODY),
        },
        body: TRUTH_BODY,
      });
      await done;
    };

    try {
      const bad = await rawRequest(port, { path: "//" });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body)).toEqual({ error: "URL inválida" });
      const home = await rawRequest(port, { path: "/" });
      expect(home.status).toBe(200);
      await finish();
    } catch (error) {
      await finish().catch(() => undefined);
      throw error;
    }
  });
});
