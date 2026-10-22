import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { startApp } from "./server.ts";
import { VARIANTES, envDe, executor, seedRaiz, type Variante } from "./editor-ui-http.test-helper.ts";

type Take = { removed: Array<{ start: number; end: number }> };
type Resposta = { project: { revision: number; scenes: Array<{ id: string; takes: Take[] }> }; undoRevision?: number };

const TAB = { "x-decupa-tab": "tab-a" };
const ORIGINAL = [{ start: 0, end: 0.5 }];

async function sobe(root: string, variante: Variante) {
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: envDe(variante) });
  const base = `http://127.0.0.1:${app.port}/projects/alpha`;
  const projeto = async () => {
    const res = await fetch(`${base}/project`);
    expect(res.status).toBe(200);
    return (await res.json() as Resposta).project;
  };
  const post = (rota: string, corpo: unknown) => fetch(`${base}/${rota}`, {
    method: "POST", headers: { ...TAB, "content-type": "application/json" }, body: JSON.stringify(corpo),
  });
  return { app, base, projeto, post };
}

const removidos = (p: Resposta["project"]) => p.scenes[0]!.takes[0]!.removed;

it.each(VARIANTES)("%s: abre, corta, desfaz e persiste ao reiniciar o servidor", async (variante) => {
  const { root } = await seedRaiz();
  try {
    let s = await sobe(root, variante);
    try {
      expect((await fetch(`${s.base}/`)).status).toBe(200);
      expect((await s.post("reservation", {})).status).toBe(200);
      const aberto = await s.projeto();
      expect(removidos(aberto)).toEqual(ORIGINAL);

      const corte = await s.post("project/edit", {
        baseRevision: aberto.revision,
        action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
      });
      expect(corte.status).toBe(200);
      const cortado = await s.projeto();
      expect(cortado.revision).toBe(aberto.revision + 1);
      expect(removidos(cortado)).toContainEqual({ start: 1, end: 2 });
      expect(removidos(cortado)).toHaveLength(2);
    } finally {
      await s.app.close();
    }

    // "Recarregar" = servidor novo na mesma Raiz.
    s = await sobe(root, variante);
    try {
      const recarregado = await s.projeto();
      expect(removidos(recarregado)).toContainEqual({ start: 1, end: 2 });
      expect(removidos(recarregado)).toHaveLength(2);
      expect((await s.post("reservation", {})).status).toBe(200);

      const desfez = await s.post("project/undo", {
        baseRevision: recarregado.revision, revision: recarregado.revision - 1,
      });
      expect(desfez.status).toBe(200);
      const desfeito = await s.projeto();
      expect(removidos(desfeito)).toEqual(ORIGINAL);
    } finally {
      await s.app.close();
    }

    s = await sobe(root, variante);
    try {
      expect(removidos(await s.projeto())).toEqual(ORIGINAL);
    } finally {
      await s.app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("edita no studio e reabre na legacy com o mesmo conteúdo", async () => {
  const { root } = await seedRaiz();
  try {
    const studio = await sobe(root, "studio");
    let esperado: Resposta["project"];
    try {
      expect((await studio.post("reservation", {})).status).toBe(200);
      const antes = await studio.projeto();
      expect((await studio.post("project/edit", {
        baseRevision: antes.revision,
        action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
      })).status).toBe(200);
      esperado = await studio.projeto();
    } finally {
      await studio.app.close();
    }

    const legacy = await sobe(root, "legacy");
    try {
      const lido = await legacy.projeto();
      expect(lido.revision).toBe(esperado.revision);
      expect(lido.scenes).toEqual(esperado.scenes);
    } finally {
      await legacy.app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
