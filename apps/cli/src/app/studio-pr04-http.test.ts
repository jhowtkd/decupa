// PR 4 pelo servidor real: a alternância legacy/studio do hub e das Receitas
// (legacy byte a byte), os ids que os scripts consultam e o que o servidor
// faz no POST project/rename que o diálogo do studio descreve.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";
import { VARIANTES, envDe, executor, seedRaiz, type Variante } from "./editor-ui-http.test-helper.ts";

const aqui = (arquivo: string) => new URL(arquivo, import.meta.url);
const ler = (arquivo: string) => readFile(aqui(arquivo), "utf8");
const TAB = { "x-decupa-tab": "tab-a" };

async function sobe(root: string, variante: Variante, extra: Record<string, unknown> = {}) {
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: envDe(variante), ...extra });
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/** A identidade local vem do usuário do sistema: o teste não a fixa, só exige que algo tenha entrado. */
function usuarioDe(servido: string): string {
  const nome = /<span class="user-name">([^<]+)<\/span>/.exec(servido)?.[1];
  expect(nome, "nome do usuário no hub servido").toBeTruthy();
  expect(nome).not.toContain("__DECUPA_USER__");
  return nome!;
}

/** O que sendProjectRootPage faz com o hub num servidor sem acervo nem Drive. */
function hubEsperado(html: string, usuario: string): string {
  return html
    .replace("__DECUPA_USER__", () => usuario)
    .replace('<meta name="decupa-media-enabled" content="">', () => '<meta name="decupa-media-enabled" content="false">')
    .replace('<meta name="decupa-drive-enabled" content="">', () => '<meta name="decupa-drive-enabled" content="false">');
}

it("legacy: o hub, as Receitas e as CSS do studio são os de hoje, byte a byte", async () => {
  const { root } = await seedRaiz();
  const { app, base } = await sobe(root, "legacy");
  try {
    const hub = await fetch(`${base}/`);
    expect(hub.status).toBe(200);
    const servido = await hub.text();
    expect(servido).toBe(hubEsperado(await ler("hub/page.html"), usuarioDe(servido)));
    const receitas = await fetch(`${base}/templates`);
    expect(receitas.status).toBe(200);
    expect(await receitas.text()).toBe(await ler("templates/page.html"));
    expect((await fetch(`${base}/templates/`)).status).toBe(200);
    expect((await fetch(`${base}/hub/studio.css`)).status).toBe(404);
    expect((await fetch(`${base}/templates/studio.css`)).status).toBe(404);
    // A CSS comum segue servida.
    expect((await fetch(`${base}/hub/page.css`)).status).toBe(200);
    expect((await fetch(`${base}/templates/page.css`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("studio: o hub traz studio.css e a meta, as Receitas voltam para Projetos e as duas CSS dão 200", async () => {
  const { root } = await seedRaiz();
  const { app, base } = await sobe(root, "studio");
  try {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("/hub/studio.css");
    expect(html).toContain('<meta name="decupa-editor-ui" content="studio">');
    expect(html).toBe(hubEsperado(await ler("hub/studio.html"), usuarioDe(html)));
    const hubCss = await fetch(`${base}/hub/studio.css`);
    expect(hubCss.status).toBe(200);
    expect(await hubCss.text()).toBe(await ler("hub/studio.css"));
    const templatesCss = await fetch(`${base}/templates/studio.css`);
    expect(templatesCss.status).toBe(200);
    expect(await templatesCss.text()).toBe(await ler("templates/studio.css"));
    const receitas = await (await fetch(`${base}/templates`)).text();
    expect(receitas).toContain("← Projetos");
    expect(receitas).toContain("/templates/studio.css");
    expect(receitas).not.toContain("__DECUPA_VOLTAR__");
    expect(receitas).toBe((await ler("templates/studio.html")).replace("__DECUPA_VOLTAR__", "Projetos"));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("studio: o startApp de projeto único (projectDir) leva as Receitas de volta à Montagem", async () => {
  const { dir, root } = await seedRaiz();
  const app = await startApp({ projectDir: dir, port: 0, executor, env: envDe("studio") });
  try {
    const receitas = await (await fetch(`http://127.0.0.1:${app.port}/templates`)).text();
    expect(receitas).toContain("← Montagem");
    expect(receitas).not.toContain("← Projetos");
    expect((await fetch(`http://127.0.0.1:${app.port}/templates/studio.css`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("studio: a Raiz com projectId também diz Montagem (/ leva ao projeto)", async () => {
  const { root } = await seedRaiz();
  const { app, base } = await sobe(root, "studio", { projectId: "alpha" });
  try {
    expect(await (await fetch(`${base}/templates`)).text()).toContain("← Montagem");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("legacy: as Receitas de projeto único também são as de hoje", async () => {
  const { dir, root } = await seedRaiz();
  const app = await startApp({ projectDir: dir, port: 0, executor, env: envDe("legacy") });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    expect(await (await fetch(`${base}/templates`)).text()).toBe(await ler("templates/page.html"));
    expect((await fetch(`${base}/templates/studio.css`)).status).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Ids que um script consulta: `$("id")` e getElementById("id"). */
function idsConsultados(fonte: string): string[] {
  const ids = new Set<string>();
  for (const m of fonte.matchAll(/(?:\$|getElementById)\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g)) ids.add(m[1]!);
  return [...ids].sort();
}
const idsDoHtml = (html: string) => new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]!));

it("estático: hub/studio.html e templates/studio.html têm os ids que os scripts consultam e o link de Configurações", async () => {
  const hubJs = idsConsultados(await ler("hub/page.js"));
  const templatesJs = idsConsultados(await ler("templates/page.js"));
  expect(hubJs.length).toBeGreaterThan(20);
  expect(templatesJs.length).toBeGreaterThan(10);
  const hubStudio = await ler("hub/studio.html");
  const templatesStudio = await ler("templates/studio.html");
  expect(hubJs.filter((id) => !idsDoHtml(hubStudio).has(id)), "ids do hub/page.js ausentes no studio").toEqual([]);
  expect(templatesJs.filter((id) => !idsDoHtml(templatesStudio).has(id)), "ids do templates/page.js ausentes no studio").toEqual([]);
  // Os ids da legacy também seguem no studio (mesmo script, mesmo contrato).
  const hubLegacy = idsDoHtml(await ler("hub/page.html"));
  expect([...hubLegacy].filter((id) => !idsDoHtml(hubStudio).has(id)), "ids do hub legacy ausentes no studio").toEqual([]);
  expect(hubStudio).toContain('href="/settings"');
  expect(templatesStudio).toContain('href="/settings"');
  expect(hubStudio).toContain('<meta name="decupa-media-enabled" content="">');
  expect(hubStudio).toContain('<meta name="decupa-drive-enabled" content="">');
  expect(hubStudio).toContain("__DECUPA_USER__");
  expect(hubStudio).toContain('src="/hub/page.js"');
});

/** Raiz com um projeto cuja prévia e aprovação valem na revisão atual. */
async function seedAprovado() {
  const root = await mkdtemp(join(tmpdir(), "studio-pr04-rename-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  const projeto = blankProject("alpha-project");
  projeto.previewRevision = projeto.revision;
  projeto.finalApprovedRevision = projeto.revision;
  await createProject(dir, projeto);
  return root;
}

it.each(VARIANTES)("%s: POST project/rename sobe a revisão em 1, zera prévia e aprovação e o Desfazer some", async (variante) => {
  const root = await seedAprovado();
  const { app, base } = await sobe(root, variante);
  try {
    const projeto = `${base}/projects/alpha`;
    const ler = async () => await (await fetch(`${projeto}/project`)).json() as {
      project: { revision: number; previewRevision: number | null; finalApprovedRevision: number | null; assembly: { name: string } };
      undoRevision: number | null;
    };
    const post = (rota: string, corpo: unknown) => fetch(`${projeto}/${rota}`, {
      method: "POST", headers: { ...TAB, "content-type": "application/json" }, body: JSON.stringify(corpo),
    });
    expect((await post("reservation", {})).status).toBe(200);
    const antes = await ler();
    expect(antes.project.previewRevision).toBe(antes.project.revision);
    expect(antes.project.finalApprovedRevision).toBe(antes.project.revision);

    const res = await post("project/rename", { nome: "Nome novo", baseRevision: antes.project.revision });
    expect(res.status).toBe(200);
    const depois = await ler();
    expect(depois.project.revision).toBe(antes.project.revision + 1);
    expect(depois.project.assembly.name).toBe("Nome novo");
    expect(depois.project.previewRevision).toBeNull();
    expect(depois.project.finalApprovedRevision).toBeNull();
    expect(depois.undoRevision ?? null).toBeNull();

    // Revisão velha: 409 e nada muda.
    const velha = await post("project/rename", { nome: "Outro", baseRevision: antes.project.revision });
    expect(velha.status).toBe(409);
    expect((await ler()).project.revision).toBe(depois.project.revision);
    // Nome vazio: 400.
    expect((await post("project/rename", { nome: "  ", baseRevision: depois.project.revision })).status).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(VARIANTES)("%s: depois de uma edição o Desfazer existe, e renomear o deixa indisponível", async (variante) => {
  const { root } = await seedRaiz();
  const { app, base } = await sobe(root, variante);
  try {
    const projeto = `${base}/projects/alpha`;
    const ler = async () => await (await fetch(`${projeto}/project`)).json() as { project: { revision: number }; undoRevision: number | null };
    const post = (rota: string, corpo: unknown) => fetch(`${projeto}/${rota}`, {
      method: "POST", headers: { ...TAB, "content-type": "application/json" }, body: JSON.stringify(corpo),
    });
    expect((await post("reservation", {})).status).toBe(200);
    const inicio = await ler();
    expect((await post("project/edit", {
      baseRevision: inicio.project.revision,
      action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
    })).status).toBe(200);
    const editado = await ler();
    expect(editado.undoRevision).not.toBeNull();
    expect((await post("project/rename", { nome: "Nome novo", baseRevision: editado.project.revision })).status).toBe(200);
    const renomeado = await ler();
    expect(renomeado.project.revision).toBe(editado.project.revision + 1);
    expect(renomeado.undoRevision ?? null).toBeNull();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
