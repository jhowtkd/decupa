import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { blankProject } from "./assembly/routes.ts";
import { createProject, loadProject } from "./assembly/store.ts";
import { startApp } from "./server.ts";
import { VARIANTES, envDe, executor, seedRaiz, type Variante } from "./editor-ui-http.test-helper.ts";

afterEach(() => { vi.restoreAllMocks(); });

const ASSEMBLY = new URL("./assembly/", import.meta.url);

/** Módulos editor/*.js que o page.js importa, extraídos do próprio fonte. */
async function editorModules(): Promise<string[]> {
  const js = await readFile(new URL("page.js", ASSEMBLY), "utf8");
  const names = [...js.matchAll(/projectPath\("(editor\/[^"]+\.js)"\)/g)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(5);
  return [...new Set(names)];
}

async function comRaiz<T>(variante: Variante, fn: (base: string, root: string, dir: string) => Promise<T>): Promise<T> {
  const { root, dir } = await seedRaiz();
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: envDe(variante) });
  try {
    return await fn(`http://127.0.0.1:${app.port}`, root, dir);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

const cssDe = (variante: Variante) => (variante === "studio" ? "studio.css" : "page.css");

it.each(VARIANTES)("%s: o HTML sob /projects/<id>/ aponta CSS e page.js com o prefixo", async (variante) => {
  await comRaiz(variante, async (base) => {
    const res = await fetch(`${base}/projects/alpha/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/projects/alpha/${cssDe(variante)}"`);
    expect(html).toContain('src="/projects/alpha/page.js"');
    expect(html).toContain('<meta name="decupa-project-prefix" content="/projects/alpha">');
    expect(html).not.toContain("__DECUPA_");
    expect(html.includes('name="decupa-editor-ui" content="studio"')).toBe(variante === "studio");
  });
});

it.each(VARIANTES)("%s: serve com o prefixo CSS, page.js, project-path, reserva e todo editor/*.js", async (variante) => {
  const modules = await editorModules();
  await comRaiz(variante, async (base) => {
    const alvos: Array<[string, RegExp]> = [
      [cssDe(variante), /^text\/css/],
      ["page.css", /^text\/css/],
      ["page.js", /javascript/],
      ["project-path.js", /javascript/],
      ["edit-reservation-ui.js", /javascript/],
      ...modules.map((m): [string, RegExp] => [m, /javascript/]),
    ];
    for (const [caminho, tipo] of alvos) {
      const res = await fetch(`${base}/projects/alpha/${caminho}`);
      expect(res.status, caminho).toBe(200);
      expect(res.headers.get("content-type"), caminho).toMatch(tipo);
      expect((await res.text()).length, caminho).toBeGreaterThan(0);
    }
  });
});

it("studio: o @import do studio.css resolvido contra a URL do próprio CSS cai em page.css do Projeto", async () => {
  await comRaiz("studio", async (base) => {
    const studioUrl = new URL("/projects/alpha/studio.css", base);
    const css = await (await fetch(studioUrl)).text();
    const alvo = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/.exec(css)![1]!;
    const resolvido = new URL(alvo, studioUrl);
    expect(resolvido.pathname).toBe("/projects/alpha/page.css");
    const res = await fetch(resolvido);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/css/);
    expect(await res.text()).toBe(await (await fetch(`${base}/projects/alpha/page.css`)).text());
  });
});

it("legacy: /projects/<id>/studio.css não existe", async () => {
  await comRaiz("legacy", async (base) => {
    expect((await fetch(`${base}/projects/alpha/studio.css`)).status).toBe(404);
  });
});

it("Projeto único (sem prefixo): o studio serve /studio.css e a legacy não", async () => {
  for (const variante of VARIANTES) {
    const dir = await mkdtemp(join(tmpdir(), "editor-ui-single-"));
    await createProject(dir, blankProject("single"));
    const app = await startApp({ projectDir: dir, port: 0, executor, env: envDe(variante) });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain(`href="/${cssDe(variante)}"`);
      const res = await fetch(`${base}/studio.css`);
      expect(res.status, variante).toBe(variante === "studio" ? 200 : 404);
      if (variante === "studio") expect(res.headers.get("content-type")).toMatch(/^text\/css/);
      expect((await fetch(`${base}/page.css`)).status).toBe(200);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it("legacy: o corpo de / é idêntico com env ausente, vazio, legacy e valor inválido", async () => {
  const { root } = await seedRaiz();
  const envs: Array<Record<string, string>> = [
    {}, { DECUPA_EDITOR_UI: "" }, { DECUPA_EDITOR_UI: "legacy" }, { DECUPA_EDITOR_UI: "novo" },
  ];
  const aviso = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const corpos: string[] = [];
    for (const env of envs) {
      const app = await startApp({ projectsRoot: root, port: 0, executor, env });
      try {
        const res = await fetch(`http://127.0.0.1:${app.port}/projects/alpha/`);
        expect(res.status).toBe(200);
        corpos.push(await res.text());
      } finally {
        await app.close();
      }
    }
    for (const corpo of corpos) {
      expect(corpo).toBe(corpos[0]);
      expect(corpo).not.toContain("decupa-editor-ui");
      expect(corpo).not.toContain("studio.css");
    }
    expect(corpos[0]).toContain('href="/projects/alpha/page.css"');
    // Só o valor inválido avisa, uma vez por boot.
    const avisos = aviso.mock.calls.filter(([msg]) => String(msg).includes("DECUPA_EDITOR_UI"));
    expect(avisos).toHaveLength(1);
    expect(String(avisos[0]![0])).toContain("novo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(VARIANTES)("%s: não-GET em /project* sem a Reserva é recusado e o Projeto não muda; o dono passa", async (variante) => {
  await comRaiz(variante, async (base, _root, dir) => {
    const url = `${base}/projects/alpha`;
    const antes = await loadProject(dir);
    const edicao = (cabecalho: Record<string, string>) => fetch(`${url}/project/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cabecalho },
      body: JSON.stringify({
        baseRevision: antes.revision,
        action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
      }),
    });
    expect((await fetch(`${url}/reservation`, { method: "POST", headers: { "x-decupa-tab": "tab-a" } })).status).toBe(200);

    for (const cabecalho of [{}, { "x-decupa-tab": "tab-b" }] as Array<Record<string, string>>) {
      const res = await edicao(cabecalho);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ dono: { nome: expect.any(String) } });
      expect(await loadProject(dir)).toEqual(antes);
    }

    expect((await edicao({ "x-decupa-tab": "tab-a" })).status).toBe(200);
    const depois = await loadProject(dir);
    expect(depois.revision).toBe(antes.revision + 1);
    expect(depois.scenes[0]!.takes[0]!.removed).toHaveLength(2);
  });
});

