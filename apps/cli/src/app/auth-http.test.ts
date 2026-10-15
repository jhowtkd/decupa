import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "./server.ts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

async function boot(extra: Record<string, string | undefined> = {}, now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "decupa-auth-"));
  const input = join(dir, "v.mp4");
  await writeFile(input, "fonte", "utf8");
  const app = await startApp({
    input, workDir: join(dir, "work"), port: 0, autoStart: false,
    env: { DECUPA_AUTH_PASSWORD: "senha certa", DECUPA_SESSION_SECRET: "segredo do teste", ...extra }, now,
  });
  stops.push(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${app.port}`, dir, input };
}

function cookieFrom(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

it("protege HTML e API, autentica com nome aparado e serve os estáticos do login", async () => {
  const { base } = await boot();
  const html = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
  expect(html.status).toBe(302);
  expect(html.headers.get("location")).toBe("/login?next=%2F");
  expect((await fetch(`${base}/`)).status).toBe(401);

  const login = await fetch(`${base}/login`, { redirect: "manual" });
  expect(login.status).toBe(200);
  expect(await login.text()).toContain("Entrar no Decupa");
  expect((await fetch(`${base}/login.js`)).status).toBe(200);
  expect((await fetch(`${base}/healthz`)).status).toBe(200);

  const submitted = await fetch(`${base}/login?next=%2Fjobs%2Fum`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ senha: "senha certa", nome: "  Ana  " }),
  });
  expect(submitted.status).toBe(303);
  expect(submitted.headers.get("location")).toBe("/jobs/um");
  const session = cookieFrom(submitted);
  expect(session).toContain("decupa_session=");
  const encodedPayload = session.slice("decupa_session=".length).split(".")[0]!;
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as { geração: string };
  expect(payload.geração).not.toBe(createHash("sha256").update("senha certa").digest("hex"));
  expect(JSON.stringify(payload)).not.toContain("senha certa");
  expect(submitted.headers.get("set-cookie")).toMatch(/HttpOnly/);
  expect(submitted.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
  expect(submitted.headers.get("set-cookie")).toMatch(/Path=\//);
  expect((await fetch(`${base}/`, { headers: { cookie: session } })).status).toBe(200);

  const logout = await fetch(`${base}/logout`, { method: "POST", headers: { cookie: session } });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/);
});

it("aceita somente next local, preservando query e hash", async () => {
  const { base } = await boot();
  const rejected = [
    "/\\evil.example/x", "\\\\evil.example", "/%5C", "//evil.example/x",
    "https://evil.example/x", "javascript:alert(1)", "/\\t/evil", "/\t/evil",
  ];
  for (const next of rejected) {
    const response = await fetch(`${base}/login?next=${encodeURIComponent(next)}`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
      body: JSON.stringify({ senha: "senha certa", nome: "Ana" }),
    });
    expect(response.status, next).toBe(303);
    expect(response.headers.get("location"), next).toBe("/");
  }
  const local = await fetch(`${base}/login?next=${encodeURIComponent("/projeto?aba=texto#fim")}`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
    body: JSON.stringify({ senha: "senha certa", nome: "Ana" }),
  });
  expect(local.headers.get("location")).toBe("/projeto?aba=texto#fim");
});

it("descarta next externo, não permite Range sem sessão e só marca Secure sob HTTPS efetivo", async () => {
  const { base } = await boot({ DECUPA_ALLOWED_HOSTS: "decupa.studio", DECUPA_TRUST_PROXY: "1" });
  const login = await fetch(`${base}/login?next=https%3A%2F%2Fattacker.example`, {
    headers: { host: `localhost:${new URL(base).port}`, "x-forwarded-host": "decupa.studio", "x-forwarded-proto": "https" },
    redirect: "manual",
  });
  expect(login.status).toBe(200);

  const range = await fetch(`${base}/media`, { headers: { range: "bytes=0-1" } });
  expect(range.status).toBe(401);
  const submitted = await fetch(`${base}/login`, {
    method: "POST", redirect: "manual",
    headers: {
      host: `localhost:${new URL(base).port}`, origin: "https://decupa.studio",
      "x-forwarded-host": "decupa.studio", "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: JSON.stringify({ senha: "senha certa", nome: "Ana" }),
  });
  expect(submitted.status).toBe(303);
  expect(submitted.headers.get("set-cookie")).toMatch(/Secure/);
  expect(submitted.headers.get("location")).toBe("/");
});

it("trocar senha invalida cookie antigo e bind exposto sem senha falha fechado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-auth-restart-"));
  const input = join(dir, "v.mp4"); await writeFile(input, "fonte", "utf8");
  const common = { input, workDir: join(dir, "work"), port: 0, autoStart: false, providerConfigDir: dir,
    env: { DECUPA_SESSION_SECRET: "segredo", DECUPA_AUTH_PASSWORD: "velha" } } as const;
  const first = await startApp(common);
  const firstBase = `http://127.0.0.1:${first.port}`;
  const login = await fetch(`${firstBase}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ senha: "velha", nome: "Ana" }) });
  const session = cookieFrom(login);
  await first.close();
  const second = await startApp({ ...common, env: { DECUPA_SESSION_SECRET: "segredo", DECUPA_AUTH_PASSWORD: "nova" } });
  stops.push(async () => { await second.close(); await rm(dir, { recursive: true, force: true }); });
  expect((await fetch(`http://127.0.0.1:${second.port}/`, { headers: { cookie: session } })).status).toBe(401);
  await expect(startApp({ input, workDir: join(dir, "other-work"), port: 0, autoStart: false, env: { DECUPA_BIND_HOST: "0.0.0.0" } })).rejects.toThrow(/DECUPA_AUTH_PASSWORD/);
});

it("relógio injetado expira a sessão", async () => {
  let clock = 1_000_000;
  const { base } = await boot({}, () => clock);
  const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ senha: "senha certa", nome: "Ana" }) });
  const session = cookieFrom(login);
  expect((await fetch(`${base}/`, { headers: { cookie: session } })).status).toBe(200);
  clock += 15 * 24 * 60 * 60 * 1000;
  expect((await fetch(`${base}/`, { headers: { cookie: session } })).status).toBe(401);
});
