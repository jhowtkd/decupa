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
  assembly: { name: string; sources: { sha256: string }[] };
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

/**
 * Palavras cortadas de uma cena, do jeito que o texto as mostra (as duas
 * variantes riscam igual). O texto é virtualizado por cena: rola até ela antes.
 */
export async function cortadas(page: Page, cena: string): Promise<string[]> {
  await page.locator(`#cena-${cena}`).scrollIntoViewIfNeeded();
  return page.locator(`#texto .word.riscado[data-scene="${cena}"]`).allTextContents();
}

/** Ordem das cenas na faixa (no studio, a trilha de vídeo; na legacy, a faixa única). */
export function ordemNaFaixa(page: Page): Promise<(string | undefined)[]> {
  return page.locator('#faixa .seq-bloco[data-kind="scene"]').evaluateAll((els) => els.map((el) => el.dataset.scene));
}

/** Seleção explícita no studio: clique na primeira palavra e Shift+clique na última. */
export async function selecionar(page: Page, primeira: string, ultima = primeira): Promise<void> {
  await page.locator(`#texto .word[data-word-id="${primeira}"]`).click();
  if (ultima !== primeira) await page.locator(`#texto .word[data-word-id="${ultima}"]`).click({ modifiers: ["Shift"] });
  await expect(page.getByRole("toolbar", { name: "Ações da seleção" })).toBeVisible();
}

export async function cortarSelecao(page: Page): Promise<void> {
  await page.getByRole("toolbar", { name: "Ações da seleção" }).getByRole("button", { name: "Cortar" }).click();
}

/**
 * Arrasta a alça de `cena` (studio, etapa Edição) até a fronteira depois de
 * `depoisDe`, antes do meio do bloco seguinte. Quem chama espera a revisão:
 * a faixa só redesenha com a resposta do servidor.
 */
export async function arrastarCena(page: Page, cena: string, depoisDe: string, seguinte: string): Promise<void> {
  const alca = (await page.locator(`.bloco-alca[data-alca="${cena}"]`).boundingBox())!;
  const antes = (await page.locator(`#faixa .lane-video .seq-bloco[data-scene="${depoisDe}"]`).boundingBox())!;
  const depois = (await page.locator(`#faixa .lane-video .seq-bloco[data-scene="${seguinte}"]`).boundingBox())!;
  const alvo = Math.min(antes.x + antes.width + 6, depois.x + depois.width / 2 - 4);
  const y = alca.y + alca.height / 2;
  await page.mouse.move(alca.x + alca.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(alvo, y + 2, { steps: 12 });
  await page.mouse.up();
}

/** Etapa ativa do studio (o body carrega `data-stage`). */
export async function irParaEtapa(page: Page, etapa: "materiais" | "edicao" | "revisao" | "entrega"): Promise<void> {
  await page.locator(`#etapa-${etapa}`).click();
  await expect(page.locator("body")).toHaveAttribute("data-stage", etapa);
}
