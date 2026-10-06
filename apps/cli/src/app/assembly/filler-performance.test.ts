import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAssemblyRuntime } from "./routes.ts";
import { createProject, loadProject } from "./store.ts";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { fillerProject, fillerPcmExec } from "./filler-test-helper.ts";
import { autoFillerTargets, fillerReport, withFillerCuts } from "./fillers.ts";
import { planFillerSnaps } from "./filler-snaps.ts";
import { cachedFillerReport } from "./filler-cache.ts";

function largeProject(wordCount: number, takeCount: number, candidates = 0) {
  const p = fillerProject(), scene = p.scenes[0]!;
  const units = wordCount / 10;
  p.assembly.sources[0]!.durationSeconds = wordCount * 0.4;
  p.analyses[0]!.words = Array.from({ length: wordCount }, (_, i) => ({ id: `w${i}`, sourceId: "a",
    start: i * 0.4 + 0.1, end: i * 0.4 + 0.3, text: i % 10 === 5 && i / 10 < candidates ? "hã" : `conteudo${i}`, confidence: 0.9 }));
  p.analyses[0]!.speech = Array.from({ length: units }, (_, i) => ({ id: `u${i}`, sourceId: "a", start: i * 4, end: i * 4 + 4,
    text: p.analyses[0]!.words.slice(i * 10, i * 10 + 10).map(w => w.text).join(" ") }));
  p.scenes = [{ ...scene, takes: Array.from({ length: takeCount }, (_, i) => {
    const n = Math.floor(i * units / takeCount);
    return { ...scene.takes[0]!, id: `t${i}`, speechId: `u${n}`, start: n * 4, end: n * 4 + 4, removed: [], protected: [] };
  }) }];
  return p;
}

it("relatório de 5.000 palavras e lote de 40 em 250 takes ficam na ordem de milissegundos", async () => {
  // Orçamentos folgados detectam o custo quadrático, sem exigir um benchmark exato.
  const empty = largeProject(5000, 60), started = performance.now();
  const report = fillerReport(empty), reportMs = performance.now() - started;
  expect(report.occurrences).toEqual([]); expect(reportMs).toBeLessThan(150);
  const p = largeProject(2500, 250, 40), targets = autoFillerTargets(p);
  expect(targets).toHaveLength(40);
  let calls = 0;
  const planStart = performance.now();
  const snaps = await planFillerSnaps(p, targets, { exec: fillerPcmExec(() => calls++) });
  const planMs = performance.now() - planStart;
  const cutStart = performance.now(), cut = withFillerCuts(p, targets, snaps, "auto"), cutMs = performance.now() - cutStart;
  expect(calls).toBe(40); expect(planMs).toBeLessThan(1000); expect(cutMs).toBeLessThan(1000);
  expect(cut.scenes[0]!.takes.filter(t => t.fillers?.cuts.length)).toHaveLength(40);
  console.info(`T2 desempenho: 5000 palavras=${reportMs.toFixed(1)}ms; 40/250 planejamento=${planMs.toFixed(1)}ms, aplicar=${cutMs.toFixed(1)}ms`);
});

it("cache reutiliza revisão/texto iguais e invalida alinhamento publicado na mesma revisão", () => {
  const p = fillerProject(), first = cachedFillerReport("performance-cache", p);
  expect(cachedFillerReport("performance-cache", structuredClone(p))).toBe(first);
  p.analyses[0]!.words[1]!.text = "tá";
  const changed = cachedFillerReport("performance-cache", p);
  expect(changed).not.toBe(first);
  expect(changed.report.occurrences[0]!.wordTexts).toEqual(["tá"]);
});


it("GET de 5.000 palavras reutiliza o relatório no poll seguinte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "filler-perf-get-")), p = largeProject(5000, 60);
  p.scenes[0]!.speechIds = p.scenes[0]!.takes.flatMap(t => t.speechId ? [t.speechId] : []);
  await createProject(dir, p);
  const runtime = createAssemblyRuntime(dir, { exec: fillerPcmExec(), port: () => 0, fillerEnv: {} });
  const get = async () => {
    const start = performance.now();
    const res = { writeHead() {}, end(value: string) { expect(JSON.parse(value).fillerReport.occurrences).toEqual([]); } };
    await runtime.handleAssembly({ method: "GET", url: "/project", headers: {} } as IncomingMessage, res as unknown as ServerResponse, dir);
    return performance.now() - start;
  };
  const saved = await loadProject(dir);
  const firstMs = await get(), first = cachedFillerReport(dir, saved), pollMs = await get();
  expect(cachedFillerReport(dir, saved)).toBe(first);
  // O GET também valida/carrega o projeto e monta outros relatórios; orçamento maior que o classificador puro.
  expect(firstMs).toBeLessThan(1000); expect(pollMs).toBeLessThan(1000);
  console.info(`T2 GET 5000 palavras: primeira=${firstMs.toFixed(1)}ms, poll=${pollMs.toFixed(1)}ms`);
});
