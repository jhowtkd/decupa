// Ensaios locais, fora do CI (projeto "ensaio"): ingestão de muitas Mídias,
// transcrição extensa e Mídia 4K, com tempos registrados em
// docs/superpowers/evidence/2026-10-23-studio-ensaios.md. Cada ensaio grava
// test-results/ensaio-<nome>.json com o ambiente.
//
//   DECUPA_E2E_TMP=/dev/shm DECUPA_E2E_FILA=1280x720x10 pnpm exec playwright test --project=ensaio
//   DECUPA_E2E_EXTENSA=1x9000x30 … -g "transcrição extensa"
import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./apoio/fixtures.ts";
import { esperarPreviaAtual, esperarProjeto, irParaEtapa, lerProjeto } from "./apoio/bancada.ts";
import { ambiente } from "./apoio/medir.ts";
import { REPO } from "./apoio/servidor.ts";

const run = promisify(execFile);
test.use({ trace: "off" });

async function registrar(nome: string, browser: Browser, dados: Record<string, unknown>): Promise<void> {
  const registro = { ensaio: nome, ambiente: ambiente(browser), ...dados };
  await mkdir(join(REPO, "test-results"), { recursive: true });
  await writeFile(join(REPO, "test-results", `ensaio-${nome}.json`), `${JSON.stringify(registro, null, 2)}\n`);
  console.log(`ensaio ${nome}: ${JSON.stringify(dados)}`);
}

/** Envia os arquivos pela fila de Materiais e mede até todos estarem no Projeto. */
async function ingerir(page: Page, url: string, id: string, arquivos: string[]): Promise<{ filaMs: number; prontosMs: number }> {
  await page.goto(`${url}/projects/${id}/`);
  await irParaEtapa(page, "materiais");
  const t0 = Date.now();
  await page.locator("#filePicker").setInputFiles(arquivos);
  await expect(page.locator("#filaLista > li")).toHaveCount(arquivos.length);
  const filaMs = Date.now() - t0;
  await expect(page.locator("#filaResumo")).toContainText(`${arquivos.length} de ${arquivos.length} no projeto`, { timeout: 600_000 });
  const prontosMs = Date.now() - t0;
  await esperarProjeto(url, id, (p) => p.assembly.sources.length === arquivos.length, "fontes no Projeto", 60_000);
  return { filaMs, prontosMs };
}

for (const n of [20, 50]) {
  test(`ingestão de ${n} Mídias pela fila`, async ({ page, semear, servidor, browser }) => {
    const semeado = await semear("fila", n);
    const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });
    const bytes = (await Promise.all(semeado.arquivos!.map((a) => stat(a)))).reduce((soma, s) => soma + s.size, 0);
    const { filaMs, prontosMs } = await ingerir(page, srv.url, semeado.projetos[0]!.id, semeado.arquivos!);
    await registrar(`ingestao-${n}`, browser, { midias: n, formato: process.env.DECUPA_E2E_FILA || "320x180x1", megabytes: +(bytes / 1e6).toFixed(1),
      filaCompletaMs: filaMs, todasNoProjetoMs: prontosMs, porMidiaMs: Math.round(prontosMs / n) });
  });
}

test("transcrição extensa: abrir o Projeto e buscar", async ({ page, semear, servidor, browser }) => {
  const escala = process.env.DECUPA_E2E_EXTENSA || "20x2000x10";
  // DECUPA_E2E_VARIANTE=legacy mede só a abertura na interface anterior (sem a busca do studio).
  const legacy = process.env.DECUPA_E2E_VARIANTE === "legacy";
  const semeado = await semear("extensa");
  const id = semeado.projetos[0]!.id;
  const srv = await servidor({ raiz: semeado.raiz, variante: legacy ? null : "studio", semMotor: true });
  const projeto = await fetch(`${srv.url}/projects/${id}/project`);
  const json = await projeto.text();
  const t0 = Date.now();
  await page.goto(`${srv.url}/projects/${id}/`);
  await expect(page.locator("#texto .word").first()).toBeVisible({ timeout: 120_000 });
  const abrirMs = Date.now() - t0;
  const palavras = Number(escala.split("x")[0]) * Number(escala.split("x")[1]);
  if (legacy) {
    await registrar(`extensa-${escala}-legacy`, browser, { escala, palavras, variante: "legacy", abrirAtePrimeiraPalavraMs: abrirMs });
    return;
  }
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Buscar" }).click();
  const campo = page.getByRole("searchbox", { name: "Buscar no texto" });
  const t1 = Date.now();
  await campo.fill(semeado.alvo!.frase);
  await expect(page.getByRole("search").locator(".busca-contador")).toHaveText("1 de 1");
  await expect(page.locator(`#texto .word.busca-atual[data-scene="${semeado.alvo!.cena}"]`).first()).toBeInViewport();
  const buscarMs = Date.now() - t1;
  await registrar(`extensa-${escala}`, browser, { escala, palavras, variante: "studio", getProjectMegabytes: +(json.length / 1e6).toFixed(1),
    abrirAtePrimeiraPalavraMs: abrirMs, buscarERevelarMs: buscarMs });
});

test("Mídia 4K: ingestão, prévia pelo motor e saída no formato da montagem", async ({ page, semear, servidor, browser }) => {
  const semeado = await semear("4k");
  const [quatroK, vazio] = semeado.projetos;
  const arquivo = semeado.arquivos![0]!;
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });
  const megabytes = +((await stat(arquivo)).size / 1e6).toFixed(1);

  // Ingestão do mesmo arquivo 4K num Projeto vazio, pelo navegador.
  const { prontosMs } = await ingerir(page, srv.url, vazio!.id, [arquivo]);

  // Projeto 4K com formato 1920×1080: a auto-prévia sai do motor no formato da montagem.
  const t0 = Date.now();
  await page.goto(`${srv.url}/projects/${quatroK!.id}/`);
  const previa = await esperarPreviaAtual(srv.url, quatroK!.id, 600_000);
  const previaMs = Date.now() - t0;
  const referencia = join(quatroK!.dir, previa.previewArtifact!.relativePath);
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", referencia]);
  const stream = (JSON.parse(stdout) as { streams: { width: number; height: number; r_frame_rate: string }[] }).streams[0]!;
  expect([stream.width, stream.height]).toEqual([1920, 1080]);
  // Primeiro play: o servidor prepara o derivado de reprodução (até 960 px).
  const t1 = Date.now();
  const derivado = await fetch(`${srv.url}/projects/${quatroK!.id}/project/preview/${previa.revision}`, { headers: { range: "bytes=0-1023" } });
  await derivado.arrayBuffer();
  const derivadoMs = Date.now() - t1;
  expect(derivado.status).toBeLessThan(300);
  await expect(page.locator("#previewPlayer")).toHaveAttribute("data-rev", String(previa.revision));
  const fonte = (await lerProjeto(srv.url, quatroK!.id)) as unknown as { assembly: { width: number; height: number } };
  await registrar("4k", browser, { fonte: "3840×2160 · 25 fps · 20 s · H.264", megabytes, ingestaoMs: prontosMs,
    previaPeloMotorMs: previaMs, saida: `${stream.width}×${stream.height} @ ${stream.r_frame_rate}`,
    formatoDaMontagem: `${fonte.assembly.width}×${fonte.assembly.height}`, derivadoDeReproducaoMs: derivadoMs });
});
