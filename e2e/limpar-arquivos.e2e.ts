// Limpar arquivos: a tela lista o que sai antes de remover, cancelar não toca
// no disco, confirmar remove só o que estava listado e o Projeto segue abrindo.
import { access } from "node:fs/promises";
import { test, expect } from "./apoio/fixtures.ts";
import { lerProjeto } from "./apoio/bancada.ts";

const existe = (path: string) => access(path).then(() => true, () => false);

test("limpar arquivos: lista, cancelar preserva, confirmar remove só o listado", async ({ page, semear, servidor }) => {
  const semeado = await semear("limpeza");
  const { id, nome } = semeado.projetos[0]!;
  const removiveis = semeado.arquivos!;
  const preservados = semeado.preservados!;
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });
  const todosExistem = async (lista: string[]) => (await Promise.all(lista.map(existe))).every(Boolean);

  await page.goto(`${srv.url}/cleanup`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await expect(page.getByRole("heading", { name: "Limpar arquivos" })).toBeVisible();
  const linha = page.locator("#projects .project", { hasText: nome });
  await expect(linha).toContainText("elegível");
  await linha.getByRole("button", { name: "Revisar limpeza" }).click();

  // O plano lista os arquivos afetados antes de qualquer remoção.
  const plano = page.locator("#plan");
  await expect(plano).toBeVisible();
  await expect(plano.locator("#planTitle")).toContainText(nome);
  const itens = page.locator("#items li");
  await expect(itens).toHaveCount(removiveis.length);
  const textos = await itens.allTextContents();
  for (const arquivo of removiveis) expect(textos.some((t) => t.includes(arquivo))).toBe(true);
  for (const arquivo of preservados) expect(textos.some((t) => t.includes(arquivo))).toBe(false);
  await expect(page.locator("#summary")).toContainText(`${removiveis.length} arquivo(s)`);
  expect(await todosExistem(removiveis)).toBe(true);
  // Sem a caixa de confirmação marcada, não remove.
  await expect(page.locator("#confirm")).toBeDisabled();

  // Cancelar: some o plano e o disco fica intacto.
  await page.locator("#agree").check();
  await expect(page.locator("#confirm")).toBeEnabled();
  await page.locator("#cancel").click();
  await expect(plano).toBeHidden();
  expect(await todosExistem([...removiveis, ...preservados])).toBe(true);

  // Revisar de novo e confirmar: sai só o que estava na lista.
  await linha.getByRole("button", { name: "Revisar limpeza" }).click();
  await expect(itens).toHaveCount(removiveis.length);
  await page.locator("#agree").check();
  if (await page.locator("#offlineLabel").isVisible()) await page.locator("#offline").check();
  await page.locator("#confirm").click();
  await expect(page.locator("#status")).toHaveText(/Limpeza concluída/);
  for (const arquivo of removiveis) expect(await existe(arquivo), arquivo).toBe(false);
  for (const arquivo of preservados) expect(await existe(arquivo), arquivo).toBe(true);

  // O Projeto continua abrindo e legível no servidor.
  const projeto = await lerProjeto(srv.url, id);
  expect(projeto.assembly.name).toBe(nome);
  await page.goto(`${srv.url}/projects/${id}/`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await expect(page.locator("body")).toHaveAttribute("data-stage", /.+/);
  // Aprovado, o Projeto abre fora da Edição; o texto está montado e o servidor o serve inteiro.
  await expect(page.locator("#texto .word")).not.toHaveCount(0);
});
