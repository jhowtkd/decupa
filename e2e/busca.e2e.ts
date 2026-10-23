// Busca no texto do studio sobre uma transcrição extensa (40 mil palavras em
// 200 cenas): contador, revelação de uma cena fora da janela virtualizada,
// navegação por teclado e a garantia de que buscar não escreve no Projeto.
import { test, expect } from "./apoio/fixtures.ts";
import { espiarEscritas, lerProjeto } from "./apoio/bancada.ts";

test("busca: contador, ocorrência fora da janela, Enter/Shift+Enter, Esc e nenhuma escrita", async ({ page, semear, servidor }) => {
  const semeado = await semear("extensa");
  const alvo = semeado.alvo!;
  const id = semeado.projetos[0]!.id;
  // Sem motor: a auto-prévia falha rápido em vez de renderizar 4,4 h.
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio", semMotor: true });
  const antes = await lerProjeto(srv.url, id);

  await page.goto(`${srv.url}/projects/${id}/`);
  await expect(page.locator("body")).toHaveAttribute("data-stage", "edicao");
  const escritas = espiarEscritas(page);
  const palavra = page.locator(`#texto .word[data-scene="${alvo.cena}"]`);
  await expect(page.locator("#texto .word").first()).toBeVisible();
  // A última cena está fora da janela virtualizada: não há palavra dela montada.
  await expect(palavra).toHaveCount(0);

  await page.getByRole("button", { name: "Buscar" }).click();
  const caixa = page.getByRole("search");
  const campo = page.getByRole("searchbox", { name: "Buscar no texto" });
  const contador = caixa.locator(".busca-contador");
  await expect(campo).toBeFocused();

  // Frase única: "1 de 1", revelada, montada e visível; Enter e Shift+Enter ficam nela.
  await campo.fill(alvo.frase);
  await expect(contador).toHaveText("1 de 1");
  const farol = page.locator(`#texto .word.busca-atual[data-scene="${alvo.cena}"]`).first();
  await expect(farol).toBeVisible();
  await expect(farol).toBeInViewport();
  await expect(farol).toHaveText("farol");
  await expect(page.locator(`#texto .word.busca-atual[data-scene="${alvo.cena}"]`)).toHaveText(["farol", "amarelo"]);
  await campo.press("Enter");
  await expect(contador).toHaveText("1 de 1");
  await campo.press("Shift+Enter");
  await expect(contador).toHaveText("1 de 1");

  // Palavra frequente: "n de m". A busca parte da ocorrência atual (a do farol,
  // no fim do texto), então o n inicial não é 1; a navegação dá a volta em m.
  await campo.fill("praça");
  await expect(contador).toHaveText(/^\d+ de \d+$/);
  const [, n0, m0] = /^(\d+) de (\d+)$/.exec((await contador.textContent())!)!;
  const total = Number(m0);
  const inicial = Number(n0);
  expect(total).toBeGreaterThan(50);
  const seguinte = (n: number) => (n % total) + 1;
  const anterior = (n: number) => ((n - 2 + total) % total) + 1;
  await campo.press("Enter");
  await expect(contador).toHaveText(`${seguinte(inicial)} de ${total}`);
  await campo.press("Shift+Enter");
  await expect(contador).toHaveText(`${inicial} de ${total}`);
  await campo.press("Shift+Enter");
  await expect(contador).toHaveText(`${anterior(inicial)} de ${total}`);
  await expect(page.locator("#texto .word.busca-atual").first()).toBeInViewport();
  // Volta ao começo do texto: de "1 de m", Shift+Enter dá a volta para "m de m".
  for (let i = 0; i < total; i++) {
    if ((await contador.textContent()) === `1 de ${total}`) break;
    await campo.press("Enter");
  }
  await expect(contador).toHaveText(`1 de ${total}`);
  await campo.press("Shift+Enter");
  await expect(contador).toHaveText(`${total} de ${total}`);

  // Consulta sem resultado.
  await campo.fill("zzzzqx");
  await expect(contador).toHaveText("Nenhuma ocorrência");

  // Esc fecha, limpa as marcas e devolve o foco à palavra da ocorrência.
  await campo.fill(alvo.frase);
  await expect(contador).toHaveText("1 de 1");
  await campo.press("Escape");
  await expect(caixa).toBeHidden();
  await expect(page.locator("#texto .word.busca, #texto .word.busca-atual")).toHaveCount(0);
  await expect(page.locator(`#texto .word[data-scene="${alvo.cena}"]`, { hasText: /^farol$/ })).toBeFocused();

  // Buscar só lê: nenhum pedido de escrita e Projeto intacto no servidor.
  expect(escritas).toEqual([]);
  expect((await lerProjeto(srv.url, id)).revision).toBe(antes.revision);
});
