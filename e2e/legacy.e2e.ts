// Retorno à interface anterior com o mesmo Projeto: o que foi editado no
// studio abre na legacy (DECUPA_EDITOR_UI ausente), a legacy edita e desfaz
// por cima, e o studio volta a abrir o resultado — inclusive o ramo de
// Refazer que a legacy criou e não mostra.
import { test, expect } from "./apoio/fixtures.ts";
import { arrastarCena, cortadas, cortarSelecao, esperarProjeto, ordemNaFaixa, selecionar } from "./apoio/bancada.ts";

const ID = "entrevista-e2e";
const META = 'meta[name="decupa-editor-ui"]';
const ORDEM = ["s2", "s3", "s4", "s1", "s5"];

/** Ordem das seções de cena no texto (as duas variantes usam `#cena-<id>`). */
const ordemNoTexto = (page: import("@playwright/test").Page) =>
  page.locator("#texto section.scene").evaluateAll((els) => els.map((el) => el.dataset.sceneSection));

test("projeto editado no studio abre, edita e desfaz na legacy e volta ao studio", async ({ page, semear, servidor }) => {
  const semeado = await semear("jornada");
  // Sem motor: este teste é sobre o Projeto, não sobre a prévia.
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio", semMotor: true });
  const projeto = `${srv.url}/projects/${ID}/`;

  // Studio: corta "Bom dia", leva s1 para depois de s4, corta "obrigado" e desfaz esse corte.
  await page.goto(projeto);
  await expect(page.locator(META)).toHaveAttribute("content", "studio");
  await expect(page.locator("body")).toHaveAttribute("data-stage", "edicao");
  await selecionar(page, "a:w0-0000", "a:w0-0001");
  await cortarSelecao(page);
  await esperarProjeto(srv.url, ID, (p) => p.revision === 1, "corte no studio");
  await arrastarCena(page, "s1", "s4", "s5");
  await esperarProjeto(srv.url, ID, (p) => p.revision === 2, "arraste no studio");
  await selecionar(page, "a:w0-0005");
  await cortarSelecao(page);
  await esperarProjeto(srv.url, ID, (p) => p.revision === 3, "segundo corte no studio");
  await page.locator("#undo").click();
  const noStudio = await esperarProjeto(srv.url, ID, (p) => p.revision === 4 && (p.undo?.redo?.length ?? 0) === 1, "desfazer no studio");
  expect(noStudio.scenes.map((s) => s.id)).toEqual(ORDEM);

  // Legacy: mesmo Projeto, servidor sem DECUPA_EDITOR_UI.
  await srv.reiniciar({ variante: null });
  await page.reload();
  await expect(page.locator(META)).toHaveCount(0);
  await expect(page.locator('link[href*="studio.css"]')).toHaveCount(0);
  await expect(page.locator("#redo")).toHaveCount(0);
  await expect.poll(() => ordemNoTexto(page)).toEqual(ORDEM);
  await expect.poll(() => ordemNaFaixa(page)).toEqual(ORDEM);
  await expect.poll(() => cortadas(page, "s1")).toEqual(["Bom", "dia"]);

  // Na legacy, clicar numa palavra cortada restaura na hora; é edição como
  // qualquer outra e encerra o ramo de Refazer criado no studio.
  await page.locator('#texto .word.riscado[data-word-id="a:w0-0000"]').click();
  const restaurado = await esperarProjeto(srv.url, ID, (p) => p.revision === 5, "restauração na legacy");
  expect(restaurado.undo?.redo ?? []).toEqual([]);
  await expect.poll(() => cortadas(page, "s1")).toEqual(["dia"]);
  await page.locator("#undo").click();
  const desfeito = await esperarProjeto(srv.url, ID, (p) => p.revision === 6, "desfazer na legacy");
  expect(desfeito.undo?.redo).toHaveLength(1);
  await expect.poll(() => cortadas(page, "s1")).toEqual(["Bom", "dia"]);

  // De volta ao studio: tudo como a legacy deixou, e o Refazer que ela criou funciona.
  await srv.reiniciar({ variante: "studio" });
  await page.reload();
  await expect(page.locator(META)).toHaveAttribute("content", "studio");
  await expect.poll(() => ordemNaFaixa(page)).toEqual(ORDEM);
  await expect.poll(() => cortadas(page, "s1")).toEqual(["Bom", "dia"]);
  await expect(page.locator("#redo")).toBeEnabled();
  await page.locator("#redo").click();
  await esperarProjeto(srv.url, ID, (p) => p.revision === 7 && (p.undo?.redo ?? []).length === 0, "refazer no studio");
  await expect.poll(() => cortadas(page, "s1")).toEqual(["dia"]);
});
