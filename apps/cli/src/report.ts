import { readFile, writeFile } from "node:fs/promises";
import { GATE_P90_MS, type MeasureReport } from "./measure.ts";

export const BLIND_METHOD = "blind-keyboard";

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  worstP90Ms: number;
  /** Trechos cuja verdade não foi marcada às cegas. */
  unverifiedTruth: number;
  gatePassed: boolean;
}

/**
 * O portão só libera quando todos os trechos passam **e** toda verdade tem
 * procedência cega. Verdade amostrada da saída do alinhador produz p90 zero
 * por construção — liberar o portão com ela seria declarar vitória sobre uma
 * tautologia.
 */
export function aggregate(reports: MeasureReport[]): ReportSummary {
  const passed = reports.filter((r) => r.gatePassed).length;
  const worstP90Ms = reports.reduce((worst, r) => Math.max(worst, r.error.p90Ms), 0);
  const unverifiedTruth = reports.filter((r) => r.truthMethod !== BLIND_METHOD).length;
  return {
    total: reports.length,
    passed,
    failed: reports.length - passed,
    worstP90Ms,
    unverifiedTruth,
    gatePassed: reports.length > 0 && passed === reports.length && unverifiedTruth === 0,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderReport(reports: MeasureReport[]): string {
  const summary = aggregate(reports);
  const rows = reports
    .map((r) => `      <tr class="${r.gatePassed ? "ok" : "bad"}">
        <td>${escapeHtml(r.input)}</td>
        <td class="n">${r.tokenCount}</td>
        <td class="n">${r.error.n}</td>
        <td class="n">${r.error.unmatched}</td>
        <td class="n">${r.error.p50Ms}</td>
        <td class="n">${r.error.p90Ms}</td>
        <td class="n">${r.error.maxMs}</td>
        <td>${r.truthMethod === BLIND_METHOD
          ? "cega"
          : `<span class="warn">${escapeHtml(r.truthMethod ?? "não declarada")}</span>`}</td>
        <td>${r.gatePassed ? "PASSOU" : "REPROVOU"}</td>
      </tr>`)
    .join("\n");

  const provenanceWarning = summary.unverifiedTruth > 0
    ? `<div class="verdict bad">
  ${summary.unverifiedTruth} de ${summary.total} trechos têm verdade sem procedência
  cega. Fronteiras amostradas da saída do alinhador produzem erro zero por
  construção — essa medição não vale. Refaça com <code>decupa mark</code>.
</div>`
    : "";

  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<title>Decupa — erro de fronteira de palavra</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 40px auto; max-width: 900px; padding: 0 20px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .sub { color: #666; margin-bottom: 24px; }
  .verdict { padding: 14px 18px; border-radius: 6px; font-weight: 600; margin-bottom: 24px; }
  .verdict.ok { background: #d6e9df; color: #2f7a5b; }
  .verdict.bad { background: #f2dcd6; color: #b34a33; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #666; }
  td.n { font-variant-numeric: tabular-nums; text-align: right; }
  tr.bad td { background: #fdf3f1; }
  .warn { color: #b34a33; font-weight: 600; }
  code { background: #eee; padding: 1px 5px; border-radius: 3px; }
</style>
<h1>Erro de fronteira de palavra</h1>
<p class="sub">
  Portão da Fase 0: p90 &le; ${GATE_P90_MS} ms em todos os trechos, com verdade
  marcada às cegas.
</p>
${provenanceWarning}
<div class="verdict ${summary.gatePassed ? "ok" : "bad"}">
  ${summary.passed} de ${summary.total} trechos passaram · pior p90 ${summary.worstP90Ms} ms ·
  ${summary.gatePassed ? "PORTÃO LIBERADO" : "PORTÃO FECHADO"}
</div>
<table>
  <thead>
    <tr>
      <th>Trecho</th><th>Tokens</th><th>Casadas</th><th>Sem par</th>
      <th>p50 ms</th><th>p90 ms</th><th>max ms</th><th>Procedência</th><th>Veredito</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
</html>
`;
}

export async function runReport(opts: {
  inputPaths: string[];
  outPath: string;
}): Promise<string> {
  const reports: MeasureReport[] = [];
  for (const path of opts.inputPaths) {
    reports.push(JSON.parse(await readFile(path, "utf8")) as MeasureReport);
  }
  const html = renderReport(reports);
  await writeFile(opts.outPath, html, "utf8");
  return html;
}
