// p95 das interações locais aquecidas do studio: selecionar palavra, abrir e
// fechar painel, trocar de etapa. Cinco repetições de aquecimento e 50
// medidas por interação, no Projeto da jornada e na transcrição extensa.
// No CI é relatório (JSON em test-results/); o teto de 100 ms só reprova
// com DECUPA_E2E_P95_GATE=1, no ambiente de referência registrado.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./apoio/fixtures.ts";
import { esperarPreviaAtual } from "./apoio/bancada.ts";
import { ambiente, amostras, eventTiming, limparEventTiming, prepararMedicao, resumo, rotular } from "./apoio/medir.ts";
import { REPO } from "./apoio/servidor.ts";

const AQUECIMENTO = 5;
const MEDIDAS = Number(process.env.DECUPA_E2E_AMOSTRAS || 50);
const TETO_MS = 100;
const GATE = process.env.DECUPA_E2E_P95_GATE === "1";
const ETAPAS = ["materiais", "edicao", "revisao", "entrega"] as const;
// Escala do projeto extenso (semear.ts); o nome entra no arquivo de resultado.
const ESCALA = process.env.DECUPA_E2E_EXTENSA || "20x2000x10";

// O trace grava snapshots do DOM a cada ação e entraria na medida.
test.use({ trace: "off" });

type Interacao = { rotulo: string; passo: (i: number) => Promise<void> };

/** Roda aquecimento + medidas de uma interação e devolve só as medidas. */
async function medir(page: Page, { rotulo, passo }: Interacao): Promise<number[]> {
  await rotular(page, `${rotulo}:aquecimento`);
  for (let i = 0; i < AQUECIMENTO; i++) await passo(i);
  await amostras(page, `${rotulo}:aquecimento`, AQUECIMENTO);
  await rotular(page, rotulo);
  for (let i = 0; i < MEDIDAS; i++) await passo(AQUECIMENTO + i);
  await rotular(page, "");
  return amostras(page, rotulo, MEDIDAS);
}

function interacoes(page: Page, palavras: string[]): Interacao[] {
  const painel = page.locator("#railToggle");
  return [
    {
      rotulo: "selecionar",
      passo: async (i) => {
        const palavra = page.locator(`#texto .word[data-word-id="${palavras[i % palavras.length]}"]`);
        await palavra.click();
        await expect(palavra).toHaveAttribute("aria-pressed", "true");
      },
    },
    {
      rotulo: "painel",
      passo: async () => {
        const antes = await painel.getAttribute("aria-expanded");
        await painel.click();
        await expect(painel).not.toHaveAttribute("aria-expanded", antes ?? "");
      },
    },
    {
      rotulo: "etapa",
      passo: async (i) => {
        const etapa = ETAPAS[i % ETAPAS.length]!;
        await page.locator(`#etapa-${etapa}`).click();
        await expect(page.locator("body")).toHaveAttribute("data-stage", etapa);
      },
    },
  ];
}

async function medirTudo(page: Page, cenario: string, palavras: string[], browser: import("@playwright/test").Browser) {
  await page.locator("#etapa-edicao").click();
  await expect(page.locator("body")).toHaveAttribute("data-stage", "edicao");
  await limparEventTiming(page);
  const resultado: Record<string, ReturnType<typeof resumo>> = {};
  for (const interacao of interacoes(page, palavras)) {
    resultado[interacao.rotulo] = resumo(await medir(page, interacao));
    // Cada interação começa da Edição, como a pessoa trabalha.
    await page.locator("#etapa-edicao").click();
    await expect(page.locator("body")).toHaveAttribute("data-stage", "edicao");
  }
  const registro = { cenario, aquecimento: AQUECIMENTO, medidas: MEDIDAS, tetoMs: TETO_MS, ambiente: ambiente(browser),
    viewport: page.viewportSize(), interacoes: resultado, eventTiming: await eventTiming(page) };
  const pasta = join(REPO, "test-results");
  await mkdir(pasta, { recursive: true });
  await writeFile(join(pasta, `desempenho-${cenario}.json`), `${JSON.stringify(registro, null, 2)}\n`);
  await test.info().attach(`desempenho-${cenario}.json`, { body: JSON.stringify(registro, null, 2), contentType: "application/json" });
  console.log(`desempenho ${cenario}: ${JSON.stringify(resultado)} · event timing ${JSON.stringify(registro.eventTiming)}`);
  for (const [rotulo, r] of Object.entries(resultado)) {
    if (GATE) expect.soft(r.p95, `p95 de ${rotulo} (${cenario})`).toBeLessThanOrEqual(TETO_MS);
  }
}

test("p95 das interações no Projeto da jornada", async ({ page, semear, servidor, browser }) => {
  test.setTimeout(600_000);
  const semeado = await semear("jornada");
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio" });
  await prepararMedicao(page);
  await page.goto(`${srv.url}/projects/entrevista-e2e/`);
  // A prévia pronta antes: nenhum render disputando a máquina durante a medida.
  await esperarPreviaAtual(srv.url, "entrevista-e2e");
  await expect(page.locator("#status")).toContainText("pronta");
  const palavras = Array.from({ length: 10 }, (_, i) => `a:w1-${String(i).padStart(4, "0")}`);
  await medirTudo(page, "jornada", palavras, browser);
});

test("p95 das interações na transcrição extensa", async ({ page, semear, servidor, browser }) => {
  test.setTimeout(900_000);
  const semeado = await semear("extensa");
  // Sem motor: a auto-prévia de 4,4 h falha na hora em vez de ocupar a máquina.
  const srv = await servidor({ raiz: semeado.raiz, variante: "studio", semMotor: true });
  await prepararMedicao(page);
  await page.goto(`${srv.url}/projects/arquivo-extenso-e2e/`);
  await expect(page.locator("#texto .word").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  const palavras = Array.from({ length: 10 }, (_, i) => `m01:w0-${String(i * 3).padStart(4, "0")}`);
  await medirTudo(page, `extensa-${ESCALA}`, palavras, browser);
});
