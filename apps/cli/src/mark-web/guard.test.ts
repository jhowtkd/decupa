import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { runMarkWeb, type MarkWebResult } from "./server.ts";

function raw(port: number, path: string, host: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, path, method: "GET", headers: { host },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function boot(): Promise<{ dir: string; port: number; saved: Promise<MarkWebResult> }> {
  const dir = await mkdtemp(join(tmpdir(), "mark-guard-"));
  let saved!: Promise<MarkWebResult>;
  const port = await new Promise<number>((resolvePort) => {
    saved = runMarkWeb({
      input: join(FIXTURES, "tone-gap.wav"),
      outPath: join(dir, "truth.json"),
      cacheDir: join(dir, "proxy"),
      port: 0,
      onListen: resolvePort,
    });
  });
  return { dir, port, saved };
}

/** O marcador só larga a porta depois de um POST /truth válido. */
async function finish(ctx: { dir: string; port: number; saved: Promise<MarkWebResult> }): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${ctx.port}/truth`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${ctx.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ boundariesMs: [1] }),
      signal: AbortSignal.timeout(5_000),
    });
    await Promise.race([ctx.saved, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  } catch { /* já encerrou */ }
  await rm(ctx.dir, { recursive: true, force: true });
}

it("mark-web recusa Host atacante com 403", async () => {
  const ctx = await boot();
  try {
    const got = await raw(ctx.port, "/", "attacker.example");
    expect(got.status).toBe(403);
    expect(got.body).toMatch(/host não permitido/);
  } finally {
    await finish(ctx);
  }
});

it("mark-web nega iframe na página", async () => {
  const ctx = await boot();
  try {
    const got = await raw(ctx.port, "/", `127.0.0.1:${ctx.port}`);
    expect(got.status).toBe(200);
    expect(String(got.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(String(got.headers["x-frame-options"]).toLowerCase()).toContain("deny");
  } finally {
    await finish(ctx);
  }
});

it("POST /truth acima de 1 MiB responde 413", async () => {
  const ctx = await boot();
  try {
    const body = JSON.stringify({ boundariesMs: [1], pad: "u".repeat(1024 * 1024) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/truth`, {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${ctx.port}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(413);
  } finally {
    await finish(ctx);
  }
});
