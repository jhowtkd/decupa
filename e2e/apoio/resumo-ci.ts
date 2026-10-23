// Resumo do job e2e para o GITHUB_STEP_SUMMARY: testes que só passaram na
// segunda tentativa (flaky, ficam registrados) e o p95 medido, que no CI é
// relatório e não reprova. Uso: node --experimental-strip-types e2e/apoio/resumo-ci.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO } from "./servidor.ts";

type Teste = { status: string; results: { status: string; retry: number }[] };
type Spec = { title: string; file: string; tests: Teste[] };
type Suite = { title: string; specs?: Spec[]; suites?: Suite[] };

const pasta = join(REPO, "test-results");
const linhas: string[] = ["### Testes de navegador (e2e)", ""];

function specs(suite: Suite): Spec[] {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];
}

try {
  const relatorio = JSON.parse(await readFile(join(pasta, "e2e-resultado.json"), "utf8")) as { suites: Suite[]; stats: Record<string, number> };
  const todos = relatorio.suites.flatMap(specs);
  const flaky = todos.filter((s) => s.tests.some((t) => t.status === "flaky"));
  const falhas = todos.filter((s) => s.tests.some((t) => t.status === "unexpected"));
  linhas.push(`${todos.length} testes · ${falhas.length} falharam · ${flaky.length} flaky (passaram só na segunda tentativa)`, "");
  for (const s of flaky) linhas.push(`- **flaky:** \`${s.file}\` › ${s.title}`);
  for (const s of falhas) linhas.push(`- **falhou:** \`${s.file}\` › ${s.title}`);
  if (flaky.length || falhas.length) linhas.push("");
} catch {
  linhas.push("Relatório JSON do Playwright ausente (a execução não chegou ao fim).", "");
}

const medidas = (await readdir(pasta).catch(() => [] as string[])).filter((n) => /^desempenho-.+\.json$/.test(n)).sort();
if (medidas.length) {
  linhas.push("#### Desempenho (relatório; o teto de 100 ms vale no ambiente de referência local)", "",
    "| Projeto | Interação | n | p50 (ms) | p95 (ms) | máx. (ms) |", "| --- | --- | --- | --- | --- | --- |");
  let ambiente = "";
  for (const nome of medidas) {
    const r = JSON.parse(await readFile(join(pasta, nome), "utf8")) as {
      cenario: string; ambiente: Record<string, string | number>;
      interacoes: Record<string, { n: number; p50: number; p95: number; max: number }>;
    };
    for (const [interacao, v] of Object.entries(r.interacoes)) {
      linhas.push(`| ${r.cenario} | ${interacao} | ${v.n} | ${v.p50} | ${v.p95} | ${v.max} |`);
    }
    ambiente = Object.entries(r.ambiente).map(([k, v]) => `${k}: ${v}`).join(" · ");
  }
  linhas.push("", `Ambiente: ${ambiente}`);
}
process.stdout.write(`${linhas.join("\n")}\n`);
