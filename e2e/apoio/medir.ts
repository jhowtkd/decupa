// Latência de interação medida dentro da página. Para cada clique real (CDP),
// conta do `timeStamp` do pointerdown até o primeiro quadro depois dos
// handlers do click (rAF e, em seguida, uma tarefa): entrada → processamento →
// pintura, como o INP. A Event Timing API confere à parte (duração por
// interação, granularidade de 8 ms, só acima de 16 ms).
import { arch, cpus, release, totalmem } from "node:os";
import type { Browser, Page } from "@playwright/test";

/**
 * Instalado antes do boot da página (addInitScript). Vai como texto: roda no
 * navegador, e o typecheck do repositório não carrega os tipos do DOM.
 */
const INSTALAR = `
(() => {
  const w = window;
  w.__medidas = [];
  w.__eventTiming = new Map();
  w.__rotulo = "";
  let inicio = 0;
  addEventListener("pointerdown", (ev) => { inicio = ev.timeStamp; }, { capture: true });
  addEventListener("click", () => {
    const rotulo = w.__rotulo;
    if (!rotulo || !inicio) return;
    const t0 = inicio;
    inicio = 0;
    requestAnimationFrame(() => {
      const canal = new MessageChannel();
      canal.port1.onmessage = () => w.__medidas.push({ rotulo, ms: performance.now() - t0 });
      canal.port2.postMessage(null);
    });
  }, { capture: true });
  try {
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries()) {
        if (!e.interactionId) continue;
        w.__eventTiming.set(e.interactionId, Math.max(w.__eventTiming.get(e.interactionId) || 0, e.duration));
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch { /* sem Event Timing: fica só a medida própria */ }
})();
`;

type Janela = { __medidas: { rotulo: string; ms: number }[]; __eventTiming: Map<number, number>; __rotulo: string };

export async function prepararMedicao(page: Page): Promise<void> {
  await page.addInitScript({ content: INSTALAR });
}

export async function rotular(page: Page, rotulo: string): Promise<void> {
  await page.evaluate((r) => { (globalThis as unknown as Janela).__rotulo = r; }, rotulo);
}

/** Espera a amostra do último clique e devolve todas as do rótulo. */
export async function amostras(page: Page, rotulo: string, esperadas: number): Promise<number[]> {
  await page.waitForFunction(([r, n]) => (globalThis as unknown as Janela).__medidas
    .filter((m) => m.rotulo === r).length >= n, [rotulo, esperadas] as const);
  return page.evaluate((r) => (globalThis as unknown as Janela).__medidas.filter((m) => m.rotulo === r).map((m) => m.ms), rotulo);
}

/** Interações que a Event Timing registrou (≥ 16 ms) e a maior duração. */
export async function eventTiming(page: Page): Promise<{ acima16: number; maxMs: number }> {
  return page.evaluate(() => {
    const valores = [...(globalThis as unknown as Janela).__eventTiming.values()];
    return { acima16: valores.length, maxMs: valores.length ? Math.max(...valores) : 0 };
  });
}

export async function limparEventTiming(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as Janela).__eventTiming.clear());
}

/** Percentil pelo posto mais próximo (p95 de 50 amostras = a 48ª menor). */
export function percentil(valores: number[], p: number): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1)]!;
}

export function resumo(valores: number[]): { n: number; p50: number; p95: number; max: number } {
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: valores.length, p50: r(percentil(valores, 50)), p95: r(percentil(valores, 95)), max: r(Math.max(...valores)) };
}

/** Ambiente em que a medida foi feita: entra junto com os números. */
export function ambiente(browser: Browser): Record<string, string | number> {
  const cpu = cpus();
  return {
    cpu: cpu[0]?.model.trim() ?? "?", nucleos: cpu.length, memoriaGiB: Math.round(totalmem() / 1024 ** 3),
    so: `${process.platform} ${release()} ${arch()}`, node: process.version,
    navegador: `${browser.browserType().name()} ${browser.version()}`, ci: process.env.CI ? "sim" : "não",
  };
}
