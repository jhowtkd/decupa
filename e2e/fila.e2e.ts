// Fila de Materiais com 20 e 50 arquivos: todos aparecem na hora, mesmo com os
// envios segurados; ao soltar, todos ficam prontos e entram no Projeto.
import { test, expect } from "./apoio/fixtures.ts";
import { esperarProjeto, irParaEtapa, lerProjeto } from "./apoio/bancada.ts";

for (const n of [20, 50]) {
  test(`fila: ${n} arquivos aparecem de uma vez e todos chegam ao Projeto`, async ({ page, semear, servidor }) => {
    const semeado = await semear("fila", n);
    const id = semeado.projetos[0]!.id;
    const arquivos = semeado.arquivos!;
    expect(arquivos).toHaveLength(n);
    const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });

    // Segura todo envio (POST project/import) até a soltura.
    let soltar!: () => void;
    const liberado = new Promise<void>((ok) => { soltar = ok; });
    let pedidos = 0;
    await page.route("**/project/import?*", async (route) => {
      pedidos += 1;
      await liberado;
      await route.continue();
    });

    await page.goto(`${srv.url}/projects/${id}/`);
    await irParaEtapa(page, "materiais");
    await page.locator("#filePicker").setInputFiles(arquivos);

    // A fila mostra os N na hora; nenhum envio terminou (o primeiro está preso).
    const itens = page.locator("#filaLista > li");
    await expect(itens).toHaveCount(n);
    await expect(page.locator("#filaMateriais")).toBeVisible();
    await expect(page.locator('#filaLista > li[data-estado="pronto"]')).toHaveCount(0);
    await expect(page.locator("#filaResumo")).toContainText(`0 de ${n} no projeto`);
    await expect.poll(() => pedidos).toBe(1);
    await expect(page.locator('#filaLista > li[data-estado="enviando"]')).toHaveCount(1);
    expect((await lerProjeto(srv.url, id)).assembly.sources).toHaveLength(0);

    soltar();
    await expect(page.locator('#filaLista > li[data-estado="pronto"]')).toHaveCount(n, { timeout: 120_000 });
    await expect(page.locator("#filaResumo")).toContainText(`${n} de ${n} no projeto`);
    await esperarProjeto(srv.url, id, (p) => p.assembly.sources.length === n, `${n} fontes no Projeto`, 120_000);
    expect(pedidos).toBe(n);
  });
}
