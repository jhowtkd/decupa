// PR 7 pelo servidor real: as telas fora da Montagem (login, Limpar arquivos,
// Configurações, Limpeza de fala e Receitas) na legacy, byte a byte, e no
// studio com o shell próprio ou derivado, sempre com os mesmos ids e scripts.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startApp, withCleanupProject } from "./server.ts";
import { withStudioShell } from "./assembly/editor-ui.ts";
import { keyProviderState, withVisualNotice } from "./provider-visual.ts";
import { sourceManifestPath } from "./session.ts";
import { VARIANTES, envDe, executor, seedRaiz, type Variante } from "./editor-ui-http.test-helper.ts";

const ler = (arquivo: string) => readFile(new URL(arquivo, import.meta.url), "utf8");
const SENHA = { DECUPA_AUTH_PASSWORD: "senha-ficticia-do-teste", DECUPA_SESSION_SECRET: "segredo-ficticio-do-teste" };

async function limpa(...dirs: string[]) { for (const d of dirs) await rm(d, { recursive: true, force: true }); }

/** Raiz com o Projeto de montagem `alpha` e o de Limpeza `limpeza` (mídia fictícia). */
async function seedComLimpeza() {
  const { root } = await seedRaiz();
  const limpeza = join(root, "limpeza");
  const input = join(root, "aula.mp4");
  await mkdir(limpeza);
  await writeFile(input, "media fake", "utf8");
  const fonte = await stat(input);
  await writeFile(sourceManifestPath(limpeza), JSON.stringify({ path: input, size: fonte.size, mtimeMs: fonte.mtimeMs }), "utf8");
  return root;
}

async function sobeRaiz(variante: Variante, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const root = await seedComLimpeza();
  const cfg = await mkdtemp(join(tmpdir(), "pr07-cfg-"));
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, providerConfigDir: cfg, env: { ...envDe(variante), ...env }, ...extra });
  return { app, base: `http://127.0.0.1:${app.port}`, root, cfg };
}

async function sobeAvulso(variante: Variante, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pr07-avulso-"));
  const cfg = await mkdtemp(join(tmpdir(), "pr07-cfg-"));
  const input = join(dir, "v.mp4");
  await writeFile(input, "fonte", "utf8");
  const app = await startApp({ input, workDir: join(dir, "work"), port: 0, autoStart: false, executor, providerConfigDir: cfg, env: { ...envDe(variante), ...env } });
  return { app, base: `http://127.0.0.1:${app.port}`, dir, cfg };
}

/** O que o runtime da Limpeza faz com page.html: o jobId vem do próprio servido. */
function limpezaEsperada(page: string, servido: string, prefix: string, css?: string): string {
  const jobId = /\|\|\s*"([0-9a-f-]{36})"/.exec(servido)?.[1];
  expect(jobId, "jobId no HTML servido").toBeDefined();
  const shell = css === undefined ? page : withStudioShell(page, css);
  return withCleanupProject(withVisualNotice(shell.replace("window.__JOB__", JSON.stringify(jobId)), keyProviderState({}, null, false).notice), prefix);
}

const ids = (html: string) => new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]!));
const consultados = (js: string) => [...new Set([...js.matchAll(/\$\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g)].map((m) => m[1]!))].sort();

// ---------- legacy: byte a byte, sem a variável ----------

it("legacy (Raiz): /cleanup, /settings, /login e a Limpeza de fala são os de hoje e nenhuma CSS do studio existe", async () => {
  const { app, base, root, cfg } = await sobeRaiz("legacy");
  try {
    expect(await (await fetch(`${base}/cleanup`)).text()).toBe(await ler("hub/cleanup.html"));
    expect(await (await fetch(`${base}/settings`)).text()).toBe(await ler("settings.html"));
    expect(await (await fetch(`${base}/login`)).text()).toBe(await ler("login/page.html"));
    const servido = await (await fetch(`${base}/projects/limpeza/`)).text();
    expect(servido).toBe(limpezaEsperada(await ler("page.html"), servido, "/projects/limpeza"));
    expect(servido).not.toContain("decupa-editor-ui");
    for (const css of ["/hub/cleanup-studio.css", "/login/studio.css", "/settings/studio.css", "/studio.css", "/projects/limpeza/studio.css"]) {
      expect((await fetch(`${base}${css}`)).status, css).not.toBe(200);
    }
    // As CSS comuns seguem servidas.
    for (const css of ["/hub/cleanup.css", "/login.css", "/settings/tokens.css"]) expect((await fetch(`${base}${css}`)).status, css).toBe(200);
  } finally { await app.close(); await limpa(root, cfg); }
});

it("legacy (Raiz com senha): /login é a página de hoje também com a autenticação ligada", async () => {
  const { app, base, root, cfg } = await sobeRaiz("legacy", {}, SENHA);
  try {
    expect(await (await fetch(`${base}/login`)).text()).toBe(await ler("login/page.html"));
    expect((await fetch(`${base}/login/studio.css`)).status).not.toBe(200);
  } finally { await app.close(); await limpa(root, cfg); }
});

it("legacy (avulso): Limpeza de fala, /settings e /login são os de hoje e /studio.css não existe", async () => {
  const { app, base, dir, cfg } = await sobeAvulso("legacy");
  try {
    const servido = await (await fetch(`${base}/`)).text();
    expect(servido).toBe(limpezaEsperada(await ler("page.html"), servido, ""));
    expect(await (await fetch(`${base}/settings`)).text()).toBe(await ler("settings.html"));
    expect(await (await fetch(`${base}/login`)).text()).toBe(await ler("login/page.html"));
    for (const css of ["/studio.css", "/settings/studio.css", "/login/studio.css"]) expect((await fetch(`${base}${css}`)).status, css).not.toBe(200);
  } finally { await app.close(); await limpa(dir, cfg); }
});

it("legacy (avulso com senha): /login segue o de hoje", async () => {
  const { app, base, dir, cfg } = await sobeAvulso("legacy", SENHA);
  try {
    expect(await (await fetch(`${base}/login`)).text()).toBe(await ler("login/page.html"));
  } finally { await app.close(); await limpa(dir, cfg); }
});

it("legacy: valor desconhecido de DECUPA_EDITOR_UI também serve a tela de hoje", async () => {
  const root = await seedComLimpeza();
  const cfg = await mkdtemp(join(tmpdir(), "pr07-cfg-"));
  const aviso: string[] = [];
  const antes = console.error;
  console.error = (m: unknown) => { aviso.push(String(m)); };
  const app = await startApp({ projectsRoot: root, port: 0, autoStart: false, executor, providerConfigDir: cfg, env: { DECUPA_EDITOR_UI: "Studio" } });
  console.error = antes;
  try {
    const base = `http://127.0.0.1:${app.port}`;
    expect(await (await fetch(`${base}/cleanup`)).text()).toBe(await ler("hub/cleanup.html"));
    expect((await fetch(`${base}/hub/cleanup-studio.css`)).status).not.toBe(200);
    expect(aviso.length).toBeGreaterThan(0);
  } finally { await app.close(); await limpa(root, cfg); }
});

// ---------- studio: shell próprio ou derivado ----------

it("studio (Raiz): /cleanup é cleanup-studio.html, as CSS dão 200 e a Limpeza de fala na Raiz é a derivada com o link prefixado", async () => {
  const { app, base, root, cfg } = await sobeRaiz("studio");
  try {
    expect(await (await fetch(`${base}/cleanup`)).text()).toBe(await ler("hub/cleanup-studio.html"));
    const css = await fetch(`${base}/hub/cleanup-studio.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(await ler("hub/cleanup-studio.css"));
    expect((await fetch(`${base}/hub/cleanup.css`)).status).toBe(200);
    expect(await (await fetch(`${base}/hub/cleanup.js`)).text()).toBe(await ler("hub/cleanup.js"));

    expect(await (await fetch(`${base}/settings`)).text()).toBe(withStudioShell(await ler("settings.html"), "/settings/studio.css"));
    const sc = await fetch(`${base}/settings/studio.css`);
    expect(sc.status).toBe(200);
    expect(await sc.text()).toBe(await ler("settings-studio.css"));

    const servido = await (await fetch(`${base}/projects/limpeza/`)).text();
    expect(servido).toBe(limpezaEsperada(await ler("page.html"), servido, "/projects/limpeza", "/projects/limpeza/studio.css"));
    expect(servido).toContain('<link rel="stylesheet" href="/projects/limpeza/studio.css">');
    const lc = await fetch(`${base}/projects/limpeza/studio.css`);
    expect(lc.status).toBe(200);
    expect(await lc.text()).toBe(await ler("studio.css"));

    // Entrega limpar arquivos e Receitas: os tokens vêm daqui.
    expect((await fetch(`${base}/settings/tokens.css`)).status).toBe(200);
    expect((await fetch(`${base}/templates`)).status).toBe(200);
  } finally { await app.close(); await limpa(root, cfg); }
});

it("studio (Raiz): ids que o cleanup.js consulta e todos os ids da legacy existem no shell do studio", async () => {
  const { app, base, root, cfg } = await sobeRaiz("studio");
  try {
    const studio = await (await fetch(`${base}/cleanup`)).text();
    const doStudio = ids(studio);
    const doJs = consultados(await ler("hub/cleanup.js"));
    expect(doJs.length).toBeGreaterThan(8);
    expect(doJs.filter((id) => !doStudio.has(id))).toEqual([]);
    expect([...ids(await ler("hub/cleanup.html"))].filter((id) => !doStudio.has(id))).toEqual([]);
  } finally { await app.close(); await limpa(root, cfg); }
});

it.each(VARIANTES)("%s: /cleanup lista os afetados antes de remover e o confirmar nasce desabilitado", async (variante) => {
  const { app, base, root, cfg } = await sobeRaiz(variante);
  try {
    const html = await (await fetch(`${base}/cleanup`)).text();
    for (const [antes, depois] of [["id=\"items\"", "id=\"confirmation\""], ["id=\"items\"", "id=\"confirm\""]] as const) {
      expect(html.indexOf(antes), antes).toBeGreaterThan(-1);
      expect(html.indexOf(antes)).toBeLessThan(html.indexOf(depois));
    }
    expect(/<button id="confirm"[^>]*\sdisabled/.test(html)).toBe(true);
    expect(html).toContain('<form id="confirmation">');
  } finally { await app.close(); await limpa(root, cfg); }
});

it("studio (avulso): Limpeza de fala derivada com /studio.css, /settings derivado e CSS 200", async () => {
  const { app, base, dir, cfg } = await sobeAvulso("studio");
  try {
    const servido = await (await fetch(`${base}/`)).text();
    expect(servido).toBe(limpezaEsperada(await ler("page.html"), servido, "", "/studio.css"));
    const css = await fetch(`${base}/studio.css`);
    expect(css.status).toBe(200);
    expect(await css.text()).toBe(await ler("studio.css"));
    expect(await (await fetch(`${base}/settings`)).text()).toBe(withStudioShell(await ler("settings.html"), "/settings/studio.css"));
    expect((await fetch(`${base}/settings/studio.css`)).status).toBe(200);
    // O corpo e o script da Limpeza não mudam: só o <head> ganha a meta e o link.
    const legacy = limpezaEsperada(await ler("page.html"), servido, "");
    expect(servido.slice(servido.indexOf("<body"))).toBe(legacy.slice(legacy.indexOf("<body")));
  } finally { await app.close(); await limpa(dir, cfg); }
});

it.each([["Raiz", true], ["avulso", false]] as const)("studio (%s com senha): /login traz o shell do studio e /login/studio.css é público", async (_nome, raiz) => {
  const sobe = raiz ? await sobeRaiz("studio", {}, SENHA) : await sobeAvulso("studio", SENHA);
  const { app, base } = sobe;
  try {
    const semSessao = await fetch(`${base}/login/studio.css`, { redirect: "manual" });
    expect(semSessao.status).toBe(200);
    expect(await semSessao.text()).toBe(await ler("login/studio.css"));
    const html = await (await fetch(`${base}/login`)).text();
    expect(html).toBe(await ler("login/studio.html"));
    expect(html).toContain('<meta name="decupa-editor-ui" content="studio">');
    expect(html).toContain('href="/login/studio.css"');
    const doHtml = ids(html);
    expect(doHtml.has("loginForm")).toBe(true);
    expect(doHtml.has("error")).toBe(true);
    expect(html).toMatch(/<input[^>]*name="nome"/);
    expect(html).toMatch(/<input[^>]*name="senha"/);
    // Sem sessão o resto continua protegido.
    expect((await fetch(`${base}/settings`, { redirect: "manual" })).status).not.toBe(200);
    expect((await fetch(`${base}/settings/studio.css`, { redirect: "manual" })).status).not.toBe(200);
  } finally { await app.close(); await limpa(...(raiz ? [(sobe as Awaited<ReturnType<typeof sobeRaiz>>).root] : [(sobe as Awaited<ReturnType<typeof sobeAvulso>>).dir]), sobe.cfg); }
});

it("studio (auth desligada): /login traz o shell do studio e a CSS do login", async () => {
  const { app, base, dir, cfg } = await sobeAvulso("studio");
  try {
    expect(await (await fetch(`${base}/login`)).text()).toBe(await ler("login/studio.html"));
    expect((await fetch(`${base}/login/studio.css`)).status).toBe(200);
  } finally { await app.close(); await limpa(dir, cfg); }
});

it("login: no studio o corpo e o script são os da legacy; só o <head> ganha a CSS e a meta", async () => {
  const [legacy, studio] = [await ler("login/page.html"), await ler("login/studio.html")];
  const corpo = (h: string) => h.slice(h.indexOf("<body"));
  expect(corpo(studio)).toBe(corpo(legacy));
  expect(studio.replace('<meta name="decupa-editor-ui" content="studio">\n', "").replace('<link rel="stylesheet" href="/login/studio.css">\n', "")).toBe(legacy);
});

it("studio: /settings/tokens.css também sai no projeto único, que entrega as Receitas", async () => {
  const { dir, root } = await seedRaiz();
  const app = await startApp({ projectDir: dir, port: 0, executor, env: envDe("studio") });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    expect((await fetch(`${base}/settings/tokens.css`)).status).toBe(200);
    expect((await fetch(`${base}/templates`)).status).toBe(200);
    expect(await (await fetch(`${base}/templates`)).text()).toContain("/settings/tokens.css");
  } finally { await app.close(); await limpa(root); }
});

// ---------- paridade de ações (estática) ----------

type Acoes = { controles: string[]; links: string[]; scripts: string[] };
function acoesDe(html: string): Acoes {
  const corpo = html.slice(html.indexOf("<head"));
  const controles = [...corpo.matchAll(/<(button|input|form|select|textarea)\b([^>]*)>/g)].map((m) => `${m[1]}#${/\sid=["']([^"']+)["']/.exec(m[2]!)?.[1] ?? /\sname=["']([^"']+)["']/.exec(m[2]!)?.[1] ?? "?"}`);
  const links = [...corpo.matchAll(/<a\b[^>]*\shref=["']([^"']+)["']/g)].map((m) => m[1]!);
  const scripts = [...corpo.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/g)].map((m) => m[1]!);
  return { controles: controles.sort(), links: links.sort(), scripts: scripts.sort() };
}
const semOs = (todos: string[], tirar: string[]) => { const r = [...todos]; for (const t of tirar) { const i = r.indexOf(t); if (i >= 0) r.splice(i, 1); } return r; };

it("paridade: limpar arquivos só troca os dois links para / por um '← Projetos' e ganha a engrenagem /settings", async () => {
  const legacy = acoesDe(await ler("hub/cleanup.html"));
  const studio = acoesDe(await ler("hub/cleanup-studio.html"));
  expect(legacy.links).toEqual(["/", "/"]);
  expect(studio.links).toEqual(["/", "/settings"]);
  expect(studio.controles).toEqual(legacy.controles);
  expect(studio.scripts).toEqual(legacy.scripts);
  expect(studio.scripts).toEqual(["/hub/cleanup.js"]);
  expect(legacy.controles).toContain("button#confirm");
  expect(await ler("hub/cleanup-studio.html")).toContain("← Projetos");
});

it("paridade: Receitas não muda nenhuma ação entre legacy e studio", async () => {
  const legacy = acoesDe(await ler("templates/page.html"));
  const studio = acoesDe(await ler("templates/studio.html"));
  expect(studio.controles).toEqual(legacy.controles);
  expect(studio.scripts).toEqual(legacy.scripts);
  expect(semOs(studio.links, legacy.links)).toEqual([]);
  expect(semOs(legacy.links, studio.links)).toEqual([]);
});

it.each([
  ["Configurações", "settings.html", "/settings/studio.css"],
  ["Limpeza de fala", "page.html", "/studio.css"],
  ["marcação manual", "../mark-web/page.html", "/studio.css"],
])("paridade: %s derivada tem o <body> idêntico e as mesmas ações", async (_nome, arquivo, css) => {
  const legacy = await ler(arquivo);
  const studio = withStudioShell(legacy, css);
  expect(studio.slice(studio.indexOf("<body"))).toBe(legacy.slice(legacy.indexOf("<body")));
  expect(acoesDe(studio).controles).toEqual(acoesDe(legacy).controles);
  expect(acoesDe(studio).links).toEqual(acoesDe(legacy).links);
  expect(acoesDe(studio).scripts).toEqual(acoesDe(legacy).scripts);
});
