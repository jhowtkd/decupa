import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "./server.ts";

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function request(port: number, host: string, options: { method?: string; origin?: string; forwardedHost?: string; forwardedProto?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.origin) headers.origin = options.origin;
    if (options.forwardedHost) headers["x-forwarded-host"] = options.forwardedHost;
    if (options.forwardedProto) headers["x-forwarded-proto"] = options.forwardedProto;
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: options.method ?? "GET", headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

async function boot(env: Record<string, string | undefined>) {
  const dir = await mkdtemp(join(tmpdir(), "origin-config-http-"));
  const app = await startApp({
    input: join(dir, "v.mp4"), port: 0, autoStart: false,
    executor: { async run() { return { code: 0, stdout: "", stderr: "" }; } }, env,
  });
  stops.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return app;
}

it("recusa Host fora da lista e aceita host configurado sem porta nas formas válidas", async () => {
  const app = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio" });
  expect((await request(app.port, "attacker.example")).status).toBe(403);
  expect((await request(app.port, "decupa.studio")).status).toBe(200);
  expect((await request(app.port, "decupa.studio:80")).status).toBe(200);
  expect((await request(app.port, "decupa.studio:443")).status).toBe(200);
  expect((await request(app.port, `decupa.studio:${app.port}`)).status).toBe(200);
  expect((await request(app.port, "decupa.studio:7789")).status).toBe(403);
});

it("host declarado com porta exige a porta exata na fronteira HTTP", async () => {
  const app = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio:8443" });
  expect((await request(app.port, "decupa.studio:8443")).status).toBe(200);
  expect((await request(app.port, "decupa.studio")).status).toBe(403);
  expect((await request(app.port, "decupa.studio:443")).status).toBe(403);
});

it("ignora X-Forwarded-Host sem confiança e o aceita com confiança apenas na lista", async () => {
  const untrusted = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio" });
  expect((await request(untrusted.port, `localhost:${untrusted.port}`, { forwardedHost: "decupa.studio" })).status).toBe(200);
  expect((await request(untrusted.port, "attacker.example", { forwardedHost: "decupa.studio" })).status).toBe(403);

  const trusted = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio", DECUPA_TRUST_PROXY: "1" });
  expect((await request(trusted.port, `localhost:${trusted.port}`, { forwardedHost: "decupa.studio" })).status).toBe(200);
  expect((await request(trusted.port, `localhost:${trusted.port}`, { forwardedHost: "attacker.example" })).status).toBe(403);
});

it("com proxy HTTPS recusa origem HTTP e aceita a origem HTTPS correspondente", async () => {
  const app = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio", DECUPA_TRUST_PROXY: "1" });
  const headers = { forwardedHost: "decupa.studio", forwardedProto: "https" };
  expect((await request(app.port, `localhost:${app.port}`, { ...headers, method: "POST", origin: "http://decupa.studio" })).status).toBe(403);
  expect((await request(app.port, `localhost:${app.port}`, { ...headers, method: "POST", origin: "https://decupa.studio" })).status).toBe(200);
});

it("usa DECUPA_ALLOWED_ORIGINS explícita e mantém o comportamento local sem configuração", async () => {
  const configured = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio", DECUPA_ALLOWED_ORIGINS: "https://editor.example" });
  expect((await request(configured.port, "decupa.studio", { method: "POST", origin: "https://editor.example" })).status).toBe(200);
  expect((await request(configured.port, "decupa.studio", { method: "POST", origin: "https://decupa.studio" })).status).toBe(403);
  expect((await request(configured.port, "decupa.studio", { method: "POST", origin: `http://localhost:${configured.port}` })).status).toBe(200);

  const local = await boot({});
  expect((await request(local.port, `localhost:${local.port}`)).status).toBe(200);
  expect((await request(local.port, "attacker.example")).status).toBe(403);
});
