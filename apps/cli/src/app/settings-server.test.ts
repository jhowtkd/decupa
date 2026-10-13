import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { credentialsPath, createCredentialsReader, readAnalysisCredentials, readCredentials, writeCredentials } from "@decupa/triage";
import { providerVisual } from "./provider-visual.ts";
import { startApp } from "./server.ts";

/** fetch (undici) ignora Host; o atacante entra por node:http, que honra o header — mesmo truque de local-guard.test.ts. */
function raw(port: number, path: string, method: string, host: string, extraHeaders: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host, ...extraHeaders } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "settings-server-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
const zaiUser = { preset: "zai" as const, apiKey: "user-zai-key-1234567890" };

/** Replica a fiação real do server.ts: dir é sempre o diretório do usuário (deste computador); loadStored mescla com o projeto. */
async function boot(userDir: string, projectDir?: string, fetchImpl?: typeof fetch) {
  const readStored = createCredentialsReader();
  const loadStored = () => readAnalysisCredentials(projectDir ?? userDir, userDir, readStored);
  const server = createServer((req, res) => {
    void providerVisual(req, res, { dir: userDir, env: {}, loadStored, invalidateStored: readStored.invalidate, loadUser: () => readStored(userDir), fetchImpl });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base };
}

it("GET /settings renderiza as três seções sem vazar nenhuma chave salva", async () => {
  const user = await folder();
  await writeCredentials(user, { ...zaiUser, openaiApiKey: "user-luna-key-1234567890", typesafeApiKey: "user-jev-key-1234567890", typesafe: true });
  const { base } = await boot(user);
  const html = await (await fetch(base + "/settings")).text();
  expect(html).toContain('id="text"'); expect(html).toContain('id="openai"'); expect(html).toContain('id="jev"');
  expect(html).not.toMatch(/user-zai-key-1234567890|user-luna-key-1234567890|user-jev-key-1234567890/);
});

it("/provider/keys e /provider/visual redirecionam (307) para /settings, inclusive o GET HTML antigo", async () => {
  const user = await folder();
  await writeCredentials(user, zaiUser);
  const { base } = await boot(user);
  for (const [path, headers] of [["/provider/visual", {}], ["/provider/keys", { accept: "text/html" }]] as const) {
    const response = await fetch(base + path, { headers, redirect: "manual" });
    expect(response.status, path).toBe(307); expect(response.headers.get("location")).toBe("/settings");
  }
  // Sem o cabeçalho HTML, /provider/keys continua devolvendo o JSON do estado (API antiga preservada).
  const json = await fetch(base + "/provider/keys");
  expect(json.status).toBe(200); expect(json.headers.get("content-type")).toContain("application/json");
});

it("sem provedor de texto NESTE COMPUTADOR, a leitura de /settings abre (estado efetivo do projeto) e o teste de chave segue 428", async () => {
  const user = await folder(), project = await folder();
  await writeCredentials(project, { preset: "custom", apiKey: "project-key", model: "muse", baseUrl: "https://meta.example/v1/chat/completions" });
  const { base } = await boot(user, project);
  // R3.1 sem-chave: sem 307 e sem 428 na leitura — a tela abre e o estado
  // mostra o efetivo (projeto) + o salvo local (vazio), sem vazar a chave.
  const page = await fetch(base + "/settings", { redirect: "manual" });
  expect(page.status).toBe(200); expect(await page.text()).toContain('id="text"');
  const api = await fetch(base + "/settings/state");
  expect(api.status).toBe(200);
  const state = await api.json() as any;
  expect(state.text).toMatchObject({ configured: true, preset: "custom", source: "project" });
  expect(state.text.saved).toMatchObject({ configured: false });
  expect(JSON.stringify(state)).not.toContain("project-key");
  // Testar chave invoca IA: continua 428 sem o texto neste computador.
  const test = await fetch(base + "/settings/test", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: '{"section":"jev"}' });
  expect(test.status).toBe(428); expect(await test.json()).toEqual({ error: "Configure o provedor de texto primeiro" });
});

it("estado efetivo do texto reflete o projeto; 'saved' mostra só a configuração local; salvar nunca grava no projeto", async () => {
  const user = await folder(), project = await folder();
  await writeCredentials(user, zaiUser);
  await writeCredentials(project, { preset: "custom", apiKey: "project-custom-key", model: "muse", baseUrl: "https://meta.example/v1/chat/completions" });
  const projectBefore = await readFile(credentialsPath(project), "utf8");
  const { base } = await boot(user, project);
  const state = await (await fetch(base + "/settings/state")).json() as any;
  expect(state.text).toMatchObject({ configured: true, preset: "custom", source: "project" });
  expect(state.text.notice).toMatch(/projeto tem credenciais próprias/);
  expect(state.text.saved).toMatchObject({ configured: true, preset: "zai" });
  expect(JSON.stringify(state)).not.toMatch(/project-custom-key|user-zai-key-1234567890/);
  const saved = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ section: "text", apiKey: "new-user-zai-key-1234567890" }) });
  expect(saved.status).toBe(200);
  const after = await saved.json() as any;
  expect(after.text.saved).toMatchObject({ preset: "zai" }); // preset local preservado, só a chave trocou
  expect(await readCredentials(user)).toMatchObject({ preset: "zai", apiKey: "new-user-zai-key-1234567890" });
  expect(await readFile(credentialsPath(project), "utf8")).toBe(projectBefore);
});

it("POST em qualquer rota /settings sem o cabeçalho Origin é recusado (403), diferente da API antiga /provider/keys", async () => {
  const user = await folder();
  await writeCredentials(user, zaiUser);
  const { base } = await boot(user);
  const noOrigin = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json" }, body: '{"section":"jev","typesafe":false}' });
  expect(noOrigin.status).toBe(403); expect(await noOrigin.json()).toEqual({ error: "origem não permitida" });
  const legacyNoOrigin = await fetch(base + "/provider/keys", { method: "POST", headers: { "content-type": "application/json" }, body: '{"section":"jev","typesafe":false}' });
  expect(legacyNoOrigin.status).toBe(200);
});

it("corpo não-JSON e corpo acima de 16 KB são recusados em /settings, sem gravar nada", async () => {
  const user = await folder();
  await writeCredentials(user, zaiUser);
  const before = await readFile(credentialsPath(user), "utf8");
  const { base } = await boot(user);
  const notJson = await fetch(base + "/settings", { method: "POST", headers: { origin: base }, body: '{"section":"jev","typesafe":false}' });
  expect(notJson.status).toBe(400);
  const tooBig = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ section: "text", apiKey: "x".repeat(16_384) }) });
  expect(tooBig.status).toBe(400);
  expect(await readFile(credentialsPath(user), "utf8")).toBe(before);
});

it("/settings/test exige Origin e nunca grava credenciais mesmo com sucesso", async () => {
  const user = await folder();
  await writeCredentials(user, { ...zaiUser, openaiApiKey: "user-luna-key-1234567890" });
  const before = await readFile(credentialsPath(user), "utf8");
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const { base } = await boot(user, undefined, fetchImpl);
  const noOrigin = await fetch(base + "/settings/test", { method: "POST", headers: { "content-type": "application/json" }, body: '{"section":"visual"}' });
  expect(noOrigin.status).toBe(403);
  const ok = await fetch(base + "/settings/test", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: '{"section":"visual"}' });
  expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ message: "Chave funcionando" });
  expect(await readFile(credentialsPath(user), "utf8")).toBe(before);
});

it("engrenagem com rótulo acessível 'Configurações' aponta para /settings em todas as telas, incluindo ela mesma", async () => {
  const root = new URL("./", import.meta.url);
  for (const file of ["page.html", "assembly/page.html", "templates/page.html", "settings.html"]) {
    const html = await readFile(new URL(file, root), "utf8");
    expect(html, file).toMatch(/<a href="\/settings" aria-label="Configurações"/);
  }
});

// A partir daqui, servidor real (startApp): cobre o portão genérico de
// Host/Origin do server.ts, que o `boot()` acima (só providerVisual) não
// exercita — a revisão pediu essa confirmação nas rotas novas.
async function realApp(userDir: string) {
  const dir = await folder();
  const app = await startApp({ projectDir: dir, port: 0, providerConfigDir: userDir, env: {} });
  cleanup.push(() => app.close());
  return { base: `http://127.0.0.1:${app.port}`, port: app.port };
}

it("Host fora da lista recebe 403 em /settings, inclusive no GET, antes de qualquer outra checagem", async () => {
  const user = await folder(); await writeCredentials(user, zaiUser);
  const { port } = await realApp(user);
  const get = await raw(port, "/settings", "GET", "attacker.example");
  expect(get.status).toBe(403); expect(get.body).toMatch(/host não permitido/);
  const post = await raw(port, "/settings", "POST", "attacker.example", { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, '{"section":"jev","typesafe":false}');
  expect(post.status).toBe(403); expect(post.body).toMatch(/host não permitido/);
});

it("Origin de outra origem (não ausente) recebe 403 em POST /settings, mesmo com Host correto", async () => {
  const user = await folder(); await writeCredentials(user, zaiUser);
  const { base } = await realApp(user);
  const response = await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: '{"section":"jev","typesafe":false}' });
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "origem não permitida" });
});

it("toda resposta de /settings* proíbe iframe (DENY) e as rotas JSON nunca ficam em cache (no-store)", async () => {
  const user = await folder(); await writeCredentials(user, zaiUser);
  const { base } = await realApp(user);
  const page = await fetch(base + "/settings");
  expect(page.headers.get("x-frame-options")?.toLowerCase()).toBe("deny");
  expect(page.headers.get("cache-control")).toBe("no-store");
  const state = await fetch(base + "/settings/state");
  expect(state.headers.get("x-frame-options")?.toLowerCase()).toBe("deny");
  expect(state.headers.get("cache-control")).toBe("no-store");
});

it("trocar o preset ou o endpoint do texto sem chave nova recusa (400) pela rota HTTP real, preservando OpenAI/Jev e a permissão 0600", async () => {
  const user = await folder();
  await writeCredentials(user, { preset: "custom", apiKey: "old-custom-key", model: "muse", baseUrl: "https://meta.example/v1/chat/completions",
    openaiApiKey: "user-luna-key-1234567890", typesafeApiKey: "user-jev-key-1234567890", typesafe: true });
  const { base } = await realApp(user);
  const post = (body: unknown) => fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  const noKeyPreset = await post({ section: "text", preset: "zai" });
  expect(noKeyPreset.status).toBe(400); expect(await noKeyPreset.json()).toEqual({ error: "Informe a chave do novo provedor" });
  const noKeyEndpoint = await post({ section: "text", baseUrl: "https://outro.example/v1/chat/completions" });
  expect(noKeyEndpoint.status).toBe(400); expect(await noKeyEndpoint.json()).toEqual({ error: "Informe a chave do novo provedor" });
  // Nenhuma das duas tentativas recusadas mexeu no arquivo: preset/endpoint do texto, OpenAI e Jev continuam como estavam.
  const saved = await readCredentials(user);
  expect(saved).toMatchObject({ preset: "custom", baseUrl: "https://meta.example/v1/chat/completions", openaiApiKey: "user-luna-key-1234567890", typesafeApiKey: "user-jev-key-1234567890", typesafe: true });
  if (process.platform !== "win32") expect((await stat(credentialsPath(user))).mode & 0o777).toBe(0o600);
  // Trocar só a chave do texto, no mesmo preset/endpoint, não afeta OpenAI nem Jev.
  const keyOnly = await post({ section: "text", apiKey: "new-custom-key-1234567890" });
  expect(keyOnly.status).toBe(200);
  expect(await readCredentials(user)).toMatchObject({ preset: "custom", apiKey: "new-custom-key-1234567890", model: "muse", baseUrl: "https://meta.example/v1/chat/completions", openaiApiKey: "user-luna-key-1234567890", typesafeApiKey: "user-jev-key-1234567890", typesafe: true });
  if (process.platform !== "win32") expect((await stat(credentialsPath(user))).mode & 0o777).toBe(0o600);
});

it("/settings/test não grava nada e não muda o mtime do arquivo de credenciais, nem em erro com chave/corpo fabricados", async () => {
  const user = await folder();
  await writeCredentials(user, { ...zaiUser, openaiApiKey: "user-luna-key-1234567890" });
  const path = credentialsPath(user);
  const before = await readFile(path, "utf8"); const beforeStat = await stat(path);
  const logSpies = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("rede indisponível para fake-leak-key-1234567890"); });
  const dir = await folder();
  const app = await startApp({ projectDir: dir, port: 0, providerConfigDir: user, env: {}, fetchImpl });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const response = await fetch(base + "/settings/test", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ section: "visual", key: "typed-fake-leak-key-1234567890" }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { message: string };
  expect(body.message).toBe("Não foi possível conectar");
  expect(JSON.stringify(body)).not.toContain("typed-fake-leak-key-1234567890");
  for (const spy of logSpies) for (const call of spy.mock.calls) expect(call.join(" ")).not.toContain("typed-fake-leak-key-1234567890");
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await stat(path)).mtimeMs).toBe(beforeStat.mtimeMs);
});
