// Jornada completa no studio, contra o servidor e os artefatos reais: abrir,
// editar (seleção explícita e Cortar), desfazer/refazer, recarregar e
// reiniciar o servidor, reordenar por arraste, revisar, aprovar e baixar os
// arquivos da Entrega conferindo revisão e conteúdo.
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect } from "./apoio/fixtures.ts";
import { esperarPreviaAtual, esperarProjeto, espiarEscritas, irParaEtapa, lerProjeto, sha256Arquivo } from "./apoio/bancada.ts";
import { REPO } from "./apoio/servidor.ts";

const run = promisify(execFile);
const ID = "entrevista-e2e";

/** Palavras cortadas de uma cena, do jeito que o texto as mostra. */
async function cortadas(page: Page, cena: string): Promise<string[]> {
  return page.locator(`#texto .word.riscado[data-scene="${cena}"]`).allTextContents();
}

test("jornada do studio: editar, histórico, reinício, arraste, revisão, aprovação e entrega", async ({ page, semear, servidor, base }) => {
  const semeado = await semear("jornada");
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });
  const dir = semeado.projetos[0]!.dir;

  // Abrir: hub do studio → Projeto.
  await page.goto(`${srv.url}/`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await page.getByRole("link", { name: "Entrevista E2E" }).click();
  await expect(page).toHaveURL(`${srv.url}/projects/${ID}/`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  // Com cenas e versão não aprovada, o studio abre na Edição; a auto-prévia renderiza pelo motor.
  await expect(page.locator("body")).toHaveAttribute("data-stage", "edicao");
  const inicial = await esperarPreviaAtual(srv.url, ID);
  expect(inicial.revision).toBe(0);

  // Seleção explícita: clique e Shift+clique selecionam sem escrever nada.
  const escritas = espiarEscritas(page);
  const palavra = (id: string) => page.locator(`#texto .word[data-word-id="${id}"]`);
  await palavra("a:w0-0000").click();
  await palavra("a:w0-0001").click({ modifiers: ["Shift"] });
  const barra = page.getByRole("toolbar", { name: "Ações da seleção" });
  await expect(barra).toBeVisible();
  await expect(palavra("a:w0-0000")).toHaveAttribute("aria-pressed", "true");
  await expect(palavra("a:w0-0001")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  expect(escritas).toEqual([]);

  // Cortar: um pedido só, com as ocorrências reais.
  await barra.getByRole("button", { name: "Cortar" }).click();
  await esperarProjeto(srv.url, ID, (p) => p.revision === 1, "revisão 1 depois de Cortar");
  expect(escritas).toHaveLength(1);
  expect(escritas[0]).toMatchObject({ caminho: "project/edit" });
  await expect.poll(() => cortadas(page, "s1")).toEqual(["Bom", "dia"]);

  // Desfazer e Refazer criam revisões novas.
  const desfazer = page.locator("#undo");
  const refazer = page.locator("#redo");
  await desfazer.click();
  await esperarProjeto(srv.url, ID, (p) => p.revision === 2, "revisão 2 depois de Desfazer");
  await expect.poll(() => cortadas(page, "s1")).toEqual([]);
  await refazer.click();
  await esperarProjeto(srv.url, ID, (p) => p.revision === 3, "revisão 3 depois de Refazer");
  await expect.poll(() => cortadas(page, "s1")).toEqual(["Bom", "dia"]);
  await desfazer.click();
  await esperarProjeto(srv.url, ID, (p) => p.revision === 4 && (p.undo?.redo?.length ?? 0) === 1, "revisão 4 com ramo de Refazer");

  // Recarregar e reiniciar o servidor: conteúdo e ramo de Refazer continuam.
  await page.reload();
  await expect(refazer).toBeEnabled();
  await expect.poll(() => cortadas(page, "s1")).toEqual([]);
  await srv.reiniciar();
  await page.reload();
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await expect(refazer).toBeEnabled();
  await refazer.click();
  const refeito = await esperarProjeto(srv.url, ID, (p) => p.revision === 5, "revisão 5 depois de Refazer pós-reinício");
  expect(refeito.undo?.redo ?? []).toEqual([]);
  await expect.poll(() => cortadas(page, "s1")).toEqual(["Bom", "dia"]);

  // Reordenar por arraste: s1 vai para depois de s4. Um pedido, uma revisão;
  // a faixa só redesenha com a resposta.
  escritas.length = 0;
  const alca = page.locator('.bloco-alca[data-alca="s1"]');
  const s4 = page.locator('#faixa .lane-video .seq-bloco[data-scene="s4"]');
  const s5 = page.locator('#faixa .lane-video .seq-bloco[data-scene="s5"]');
  const a = (await alca.boundingBox())!;
  const b4 = (await s4.boundingBox())!;
  const b5 = (await s5.boundingBox())!;
  const alvo = Math.min(b4.x + b4.width + 6, b5.x + b5.width / 2 - 4);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(alvo, a.y + a.height / 2 + 2, { steps: 12 });
  await page.mouse.up();
  const reordenado = await esperarProjeto(srv.url, ID, (p) => p.revision === 6, "revisão 6 depois do arraste");
  expect(reordenado.scenes.map((s) => s.id)).toEqual(["s2", "s3", "s4", "s1", "s5"]);
  expect(escritas).toHaveLength(1);
  expect(escritas[0]).toMatchObject({ caminho: "project/edit", corpo: { action: { type: "reorder-scenes", order: ["s2", "s3", "s4", "s1", "s5"] } } });
  await expect.poll(() => page.locator("#faixa .lane-video .seq-bloco").evaluateAll((els) => els.map((el) => el.dataset.scene)))
    .toEqual(["s2", "s3", "s4", "s1", "s5"]);

  // Revisão: a auto-prévia da v6 sai do motor; os cinco dados aparecem.
  const previa = await esperarPreviaAtual(srv.url, ID);
  expect(previa.revision).toBe(6);
  await irParaEtapa(page, "revisao");
  const painel = page.locator("#revisaoPainel");
  await expect(painel).toBeVisible();
  const bloco = (id: string) => painel.locator(`[data-bloco="${id}"] .revisao-valor`);
  await expect(painel.locator("dt")).toHaveText(["Montagem", "Prévia exibida", "Cobertura assistida", "Aprovada", "Arquivos para entrega"]);
  await expect(bloco("montagem")).toHaveText("v6");
  await expect(bloco("previa")).toHaveText("v6");
  await expect(bloco("cobertura")).toHaveText("0%");
  await expect(bloco("aprovada")).toHaveText("Nenhuma");
  await expect(bloco("entrega")).toHaveText("Nenhum");

  // Assistir um trecho: a cobertura sobe, mas não chega a 100%.
  const video = page.locator("#previewPlayer");
  await expect(video).toHaveAttribute("data-rev", "6");
  await video.evaluate((el) => { const v = el as unknown as { currentTime: number; play(): Promise<void> }; v.currentTime = 0; return v.play(); });
  await page.waitForTimeout(4500);
  await video.evaluate((el) => (el as unknown as { pause(): void }).pause());
  await expect(bloco("cobertura")).not.toHaveText("0%");
  await expect(bloco("cobertura")).not.toHaveText("100%");

  // Aprovar sem ter visto tudo pede confirmação explícita.
  const confirmacoes: string[] = [];
  page.once("dialog", (dialog) => { confirmacoes.push(dialog.message()); void dialog.accept(); });
  await page.locator("#approveFinal").click();
  const aprovado = await esperarProjeto(srv.url, ID, (p) => p.finalApprovedRevision === 6, "v6 aprovada");
  expect(confirmacoes).toEqual(["Você ainda não assistiu à prévia inteira. Aprovar mesmo assim?"]);
  await expect(bloco("aprovada")).toHaveText("v6");
  await expect(bloco("entrega")).toHaveText("A preparar");

  // Entrega: preparar os arquivos da v6 e baixar.
  await irParaEtapa(page, "entrega");
  const item = (id: string) => page.locator(`.entrega-item[data-item="${id}"]`);
  await expect(item("video")).toHaveAttribute("data-estado", "preparar");
  await page.locator("#exportTimeline").click();
  await expect(item("video")).toHaveAttribute("data-estado", "disponivel", { timeout: 60_000 });
  await expect(item("legendas")).toHaveAttribute("data-estado", "disponivel");
  for (const id of ["video", "legendas", "continuidade"]) await expect(item(id).locator(".entrega-rev")).toHaveText("v6");

  const pasta = join(base, "baixados");
  async function baixar(link: ReturnType<Page["locator"]>): Promise<{ nome: string; path: string }> {
    const nome = (await link.getAttribute("download"))!;
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe(nome);
    const path = join(pasta, nome);
    await download.saveAs(path);
    return { nome, path };
  }
  const mp4 = await baixar(item("video").locator("a[download]"));
  const legendas = item("legendas").locator("a[download]");
  await expect(legendas).toHaveCount(2);
  const vtt = await baixar(legendas.nth(0));
  const srt = await baixar(legendas.nth(1));
  const continuidade = item("continuidade").locator("a[download]");
  const nomesContinuidade = await continuidade.evaluateAll((els) => els.map((el) => el.getAttribute("download")));
  const verificacao = await baixar(item("continuidade").locator('a[download="decupa-r6-verificacao.json"]'));
  // Sem Resolve no servidor a continuidade é o pacote portátil (timeline, fontes e instruções).
  const pacote = await baixar(item("continuidade").locator('a[download="decupa-r6.tar"]'));
  const extraido = join(base, "pacote");
  await mkdir(extraido);
  await run("tar", ["-xf", pacote.path, "-C", extraido]);
  const { stdout: lista } = await run("tar", ["-tf", pacote.path]);
  expect(lista.trim().split("\n")).toEqual(expect.arrayContaining(["timeline.otio", "reference.mp4", "legendas.vtt", "legendas.srt", "importar-no-resolve.txt"]));

  // Revisão nos nomes; vídeo = prévia aprovada (bytes); legendas = subtitleRecord da v6.
  expect([mp4.nome, vtt.nome, srt.nome]).toEqual(["decupa-r6-reference.mp4", "decupa-r6-legendas.vtt", "decupa-r6-legendas.srt"]);
  expect(nomesContinuidade).toEqual(["decupa-r6.tar", "decupa-r6-importar-no-resolve.txt", "decupa-r6-verificacao.json"]);
  expect(await sha256Arquivo(mp4.path)).toBe(aprovado.previewArtifact!.sha256);
  const { stdout } = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", join(REPO, "e2e/apoio/legendas.ts"), dir]);
  const registro = JSON.parse(stdout) as { revision: number; legendas: { status: string }; vtt: string | null; srt: string | null };
  expect(registro.revision).toBe(6);
  expect(registro.legendas.status).toBe("pronto");
  expect(await readFile(vtt.path, "utf8")).toBe(registro.vtt);
  expect(await readFile(srt.path, "utf8")).toBe(registro.srt);
  // As legendas seguem a ordem nova: a fala da cena s1 vem depois da de s4.
  expect(registro.vtt!.indexOf("Bom dia")).toBe(-1);
  expect(registro.vtt!.indexOf("equipe")).toBeLessThan(registro.vtt!.indexOf("a todos"));
  // O pacote leva os mesmos bytes: vídeo aprovado e legendas da v6.
  expect(await sha256Arquivo(join(extraido, "reference.mp4"))).toBe(aprovado.previewArtifact!.sha256);
  expect(await readFile(join(extraido, "legendas.vtt"), "utf8")).toBe(registro.vtt);
  expect(await readFile(join(extraido, "legendas.srt"), "utf8")).toBe(registro.srt);
  const conferencia = JSON.parse(await readFile(verificacao.path, "utf8")) as { revision: number; artefato: { reference: string } };
  expect(conferencia).toMatchObject({ revision: 6, artefato: { reference: aprovado.previewArtifact!.sha256 } });
  const final = await lerProjeto(srv.url, ID);
  expect(final).toMatchObject({ revision: 6, finalApprovedRevision: 6, previewRevision: 6 });
});
