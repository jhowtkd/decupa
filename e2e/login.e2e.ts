// Login do studio com a autenticação ligada: o hub só abre depois da senha, a
// tela de entrada é a do studio e a senha errada não deixa passar.
import { test, expect } from "./apoio/fixtures.ts";

const SENHA = "senha-de-teste-e2e";

test("login: / leva ao login do studio; senha errada não entra; a certa abre o hub e o Projeto", async ({ page, semear, servidor }) => {
  const semeado = await semear("jornada");
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio", senha: SENHA });
  const id = semeado.projetos[0]!.id;

  // Sem sessão, / redireciona ao login, que preserva o destino.
  await page.goto(`${srv.url}/`);
  await expect(page).toHaveURL(`${srv.url}/login?next=%2F`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await expect(page.locator('link[href="/login/studio.css"]')).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Entrar no Decupa" })).toBeVisible();
  const css = await page.request.get(`${srv.url}/login/studio.css`);
  expect(css.status()).toBe(200);
  expect(css.headers()["content-type"]).toContain("text/css");
  // Rota protegida por API sem sessão: 401, não conteúdo.
  expect((await page.request.get(`${srv.url}/projects/${id}/project`, { headers: { accept: "application/json" } })).status()).toBe(401);

  // Senha errada: mostra o erro e continua no login.
  await page.getByLabel("Nome de exibição").fill("Pessoa E2E");
  await page.getByLabel("Senha").fill("senha-errada");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert")).toHaveText("senha ou nome inválido");
  await expect(page).toHaveURL(/\/login/);
  expect((await page.context().cookies()).filter((c) => c.name === "decupa_session")).toEqual([]);

  // Senha certa: entra no hub do studio e abre o Projeto.
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(`${srv.url}/`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await page.getByRole("link", { name: "Entrevista E2E" }).click();
  await expect(page).toHaveURL(`${srv.url}/projects/${id}/`);
  await expect(page.locator('meta[name="decupa-editor-ui"]')).toHaveAttribute("content", "studio");
  await expect(page.locator("body")).toHaveAttribute("data-stage", "edicao");
  await expect(page.locator("#texto .word").first()).toBeVisible();
});
