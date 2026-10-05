import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp, type AppHandle } from "./server.ts";

// fetch (undici) ignora Host. O atacante entra por node:http, que honra o header.
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

function frameHeaders(headers: IncomingHttpHeaders): void {
  expect(String(headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  expect(String(headers["x-frame-options"]).toLowerCase()).toContain("deny");
}

const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function limpar(): Promise<AppHandle> {
  const dir = await mkdtemp(join(tmpdir(), "guard-limpar-"));
  const app = await startApp({
    input: join(dir, "v.mp4"), port: 0, autoStart: false, executor, env: {},
  });
  stops.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return app;
}

async function montagem(providerConfigDir?: string): Promise<AppHandle> {
  const dir = await mkdtemp(join(tmpdir(), "guard-montar-"));
  const app = await startApp({
    projectDir: dir, port: 0, executor, env: {}, providerConfigDir,
  });
  stops.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return app;
}

it("Host atacante recebe 403 no GET da limpeza", async () => {
  const app = await limpar();
  const got = await raw(app.port, "/", "attacker.example");
  expect(got.status).toBe(403);
  expect(got.body).toMatch(/host não permitido/);
});

it("localhost na porta do servidor passa e a página da limpeza não entra em iframe", async () => {
  const app = await limpar();
  const got = await raw(app.port, "/", `localhost:${app.port}`);
  expect(got.status).toBe(200);
  expect(got.body.toLowerCase()).toContain("<!doctype html>");
  frameHeaders(got.headers);
});

it("Host atacante recebe 403 em /project e /templates da montagem", async () => {
  const app = await montagem();
  const project = await raw(app.port, "/project", "attacker.example");
  const templates = await raw(app.port, "/templates", "attacker.example");
  expect(project.status).toBe(403);
  expect(project.body).toMatch(/host não permitido/);
  expect(templates.status).toBe(403);
});

it("a montagem e /templates mandam os headers anti-iframe", async () => {
  const app = await montagem();
  const page = await raw(app.port, "/", `127.0.0.1:${app.port}`);
  const templates = await raw(app.port, "/templates", `127.0.0.1:${app.port}`);
  expect(page.status).toBe(200);
  expect(templates.status).toBe(200);
  frameHeaders(page.headers);
  frameHeaders(templates.headers);
});

it("o formulário do provedor também recusa Host atacante e nega iframe", async () => {
  // Dir vazio: sem credencial a primeira abertura é o HTML de configuração.
  // env {} impede a chave da empresa de pular o formulário.
  const home = await mkdtemp(join(tmpdir(), "guard-home-"));
  stops.push(() => rm(home, { recursive: true, force: true }));
  const app = await montagem(home);
  const blocked = await raw(app.port, "/", "attacker.example");
  expect(blocked.status).toBe(403);
  expect(blocked.body).toMatch(/host não permitido/);
  const page = await raw(app.port, "/", `127.0.0.1:${app.port}`);
  expect(page.status).toBe(200);
  expect(page.body).toContain("Configure a IA do Decupa");
  frameHeaders(page.headers);
});

it("POST /jobs/:id/keep acima de 1 MiB responde 413", async () => {
  const app = await limpar();
  const body = JSON.stringify({ keepList: "u001 ".repeat(220_000) });
  expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
  const res = await fetch(`http://127.0.0.1:${app.port}/jobs/${app.jobId}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(res.status).toBe(413);
});
