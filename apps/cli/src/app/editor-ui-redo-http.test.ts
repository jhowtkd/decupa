import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { startApp } from "./server.ts";
import { VARIANTES, envDe, executor, seedRaiz, type Variante } from "./editor-ui-http.test-helper.ts";

type Take = { removed: Array<{ start: number; end: number }> };
type Projeto = {
  revision: number;
  scenes: Array<{ id: string; takes: Take[] }>;
  undo?: { head: number; steps: unknown[]; redo?: unknown[] };
};
type Resposta = { project: Projeto; undoRevision: number | null; redoRevision: number | null };

const TAB = { "x-decupa-tab": "tab-a" };
const ORIGINAL = [{ start: 0, end: 0.5 }];
const removidos = (p: Projeto) => p.scenes[0]!.takes[0]!.removed;

async function sobe(root: string, variante: Variante) {
  const app = await startApp({ projectsRoot: root, port: 0, executor, env: envDe(variante) });
  const base = `http://127.0.0.1:${app.port}/projects/alpha`;
  const corpo = async () => {
    const res = await fetch(`${base}/project`);
    expect(res.status).toBe(200);
    return await res.json() as Resposta;
  };
  const post = (rota: string, body: unknown) => fetch(`${base}/${rota}`, {
    method: "POST", headers: { ...TAB, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, corpo, post };
}

it.each(VARIANTES)("%s: desfazer, recarregar, refazer e recarregar de novo preservam o Refazer e o conteúdo", async (variante) => {
  const { root } = await seedRaiz();
  try {
    let s = await sobe(root, variante);
    try {
      expect((await s.post("reservation", {})).status).toBe(200);
      const aberto = (await s.corpo()).project;
      expect((await s.post("project/edit", {
        baseRevision: aberto.revision,
        action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
      })).status).toBe(200);
      const cortado = await s.corpo();
      expect(removidos(cortado.project)).toHaveLength(2);
      expect(cortado.redoRevision).toBeNull();
      const desfez = await s.post("project/undo", { baseRevision: cortado.project.revision, revision: cortado.undoRevision });
      expect(desfez.status).toBe(200);
      const desfeito = await s.corpo();
      expect(removidos(desfeito.project)).toEqual(ORIGINAL);
      expect(desfeito.redoRevision).not.toBeNull();
    } finally {
      await s.app.close();
    }

    // Reinício do servidor: o Refazer vem do disco.
    s = await sobe(root, variante);
    let revisaoRefeita: number;
    try {
      const recarregado = await s.corpo();
      expect(removidos(recarregado.project)).toEqual(ORIGINAL);
      expect(recarregado.redoRevision).toBe((recarregado.project.undo!.redo!.at(-1) as { revision: number }).revision);
      expect(recarregado.redoRevision).not.toBeNull();
      expect((await s.post("reservation", {})).status).toBe(200);
      const refez = await s.post("project/redo", {
        baseRevision: recarregado.project.revision, revision: recarregado.redoRevision,
      });
      expect(refez.status).toBe(200);
      const refeito = await s.corpo();
      expect(removidos(refeito.project)).toHaveLength(2);
      expect(removidos(refeito.project)).toContainEqual({ start: 1, end: 2 });
      expect(refeito.project.revision).toBeGreaterThan(recarregado.project.revision);
      expect(refeito.redoRevision).toBeNull();
      revisaoRefeita = refeito.project.revision;
    } finally {
      await s.app.close();
    }

    s = await sobe(root, variante);
    try {
      const final = await s.corpo();
      expect({ revision: final.project.revision, cortes: removidos(final.project), redoRevision: final.redoRevision })
        .toEqual({ revision: revisaoRefeita, cortes: expect.arrayContaining([{ start: 1, end: 2 }]), redoRevision: null });
      expect(removidos(final.project)).toHaveLength(2);
      // O Desfazer do refeito volta a existir.
      expect(final.undoRevision).not.toBeNull();
    } finally {
      await s.app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(VARIANTES)("%s: nova edição depois de desfazer e recarregar não deixa Refazer", async (variante) => {
  const { root } = await seedRaiz();
  try {
    let s = await sobe(root, variante);
    try {
      expect((await s.post("reservation", {})).status).toBe(200);
      const aberto = (await s.corpo()).project;
      expect((await s.post("project/edit", {
        baseRevision: aberto.revision,
        action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
      })).status).toBe(200);
      const c = await s.corpo();
      expect((await s.post("project/undo", { baseRevision: c.project.revision, revision: c.undoRevision })).status).toBe(200);
      const d = await s.corpo();
      const alvo = d.redoRevision;
      expect(alvo).not.toBeNull();
      expect((await s.post("project/edit", {
        baseRevision: d.project.revision,
        action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"] },
      })).status).toBe(200);
    } finally {
      await s.app.close();
    }
    s = await sobe(root, variante);
    try {
      const g = await s.corpo();
      expect({ redoRevision: g.redoRevision, ramo: g.project.undo?.redo }).toEqual({ redoRevision: null, ramo: undefined });
    } finally {
      await s.app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
