// Ajudantes da bancada: estado do Projeto lido no servidor (a verdade, nunca
// o DOM), espera por revisão e espião dos pedidos de escrita da página.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, type Request } from "@playwright/test";

export type ProjetoServidor = {
  revision: number;
  previewRevision: number | null;
  finalApprovedRevision: number | null;
  previewArtifact: { revision: number; assemblySha256: string; relativePath: string; sha256: string } | null;
  scenes: { id: string; takes: { id: string; removed: { start: number; end: number }[] }[] }[];
  undo?: { head: number; steps: { revision: number; label: string }[]; redo?: { revision: number; label: string }[] };
  assembly: { name: string };
};

/** GET do Projeto direto no servidor, fora da página (sem disputar a Reserva). */
export async function lerProjeto(url: string, id: string, headers: Record<string, string> = {}): Promise<ProjetoServidor> {
  const res = await fetch(`${url}/projects/${id}/project`, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`GET project: ${res.status}`);
  return ((await res.json()) as { project: ProjetoServidor }).project;
}

export async function esperarProjeto(url: string, id: string, condicao: (p: ProjetoServidor) => boolean, rotulo: string, timeout = 60_000): Promise<ProjetoServidor> {
  let ultimo: ProjetoServidor | null = null;
  await expect.poll(async () => { ultimo = await lerProjeto(url, id); return condicao(ultimo); }, { message: rotulo, timeout, intervals: [250] }).toBe(true);
  return ultimo!;
}

/** A prévia pronta é a da revisão atual (render real pelo motor). */
export function esperarPreviaAtual(url: string, id: string, timeout = 120_000): Promise<ProjetoServidor> {
  return esperarProjeto(url, id, (p) => p.previewRevision === p.revision && p.previewArtifact?.revision === p.revision, "prévia da revisão atual", timeout);
}

export type Escrita = { method: string; caminho: string; corpo: unknown };

/**
 * Registra os pedidos de escrita da página ao Projeto. Ficam de fora a Reserva
 * de Edição (sinal de vida da aba) e a auto-prévia, que não são edição.
 */
export function espiarEscritas(page: Page): Escrita[] {
  const escritas: Escrita[] = [];
  page.on("request", (req: Request) => {
    if (req.method() === "GET" || req.method() === "HEAD") return;
    const caminho = new URL(req.url()).pathname;
    if (!/\/project\b/.test(caminho) || /\/reservation\b/.test(caminho) || caminho.endsWith("/project/preview")) return;
    let corpo: unknown = null;
    try { corpo = req.postDataJSON(); } catch { corpo = req.postData(); }
    escritas.push({ method: req.method(), caminho: caminho.replace(/^\/projects\/[^/]+\//, ""), corpo });
  });
  return escritas;
}

export async function sha256Arquivo(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Etapa ativa do studio (o body carrega `data-stage`). */
export async function irParaEtapa(page: Page, etapa: "materiais" | "edicao" | "revisao" | "entrega"): Promise<void> {
  await page.locator(`#etapa-${etapa}`).click();
  await expect(page.locator("body")).toHaveAttribute("data-stage", etapa);
}
