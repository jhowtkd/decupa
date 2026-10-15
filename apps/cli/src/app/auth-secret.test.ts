import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAuthRuntime } from "./auth.ts";
import { resolveHostConfig } from "../http/origin.ts";

type Running = { server: ReturnType<typeof createServer>; port: number };

async function listen(runtime: Awaited<ReturnType<typeof createAuthRuntime>>): Promise<Running> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void runtime.handlePublic(req, res, url).then(handled => {
      if (handled) return;
      if (!runtime.authorize(req, res, url)) return;
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as { port: number }).port };
}

async function close(running: Running): Promise<void> {
  running.server.closeAllConnections();
  await new Promise<void>(resolve => running.server.close(() => resolve()));
}

it("subidas concorrentes com segredo vazio usam a mesma chave publicada", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-auth-secret-race-"));
  await mkdir(join(dir, ".decupa"));
  await writeFile(join(dir, ".decupa", "session-secret"), "", "utf8");
  const env = { DECUPA_AUTH_PASSWORD: "senha", DECUPA_SESSION_SECRET: undefined };
  const network = resolveHostConfig({});
  const runtimes = await Promise.all(Array.from({ length: 32 }, () => createAuthRuntime({ env, configDir: dir, network })));
  const servers: Running[] = [];
  try {
    for (const runtime of runtimes) servers.push(await listen(runtime));
    const cookies = await Promise.all(servers.map(({ port }) => fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senha: "senha", nome: "Ana" }),
    }).then(response => response.headers.get("set-cookie")?.split(";")[0] ?? "")));
    const sharedCookie = cookies[0]!;
    const statuses = await Promise.all(servers.map(({ port }) => fetch(`http://127.0.0.1:${port}/protected`, {
      headers: { cookie: sharedCookie },
    }).then(response => response.status)));
    expect(statuses).toEqual(Array.from({ length: servers.length }, () => 200));
    expect((await readFile(join(dir, ".decupa", "session-secret"), "utf8")).trim()).not.toBe("");
  } finally {
    await Promise.all(servers.map(close));
    await Promise.all(runtimes.map(runtime => runtime.close()));
    await rm(dir, { recursive: true, force: true });
  }
});
