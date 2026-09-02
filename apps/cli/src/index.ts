#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runGold } from "./gold.ts";
import { GATE_P90_MS, runMeasure } from "./measure.ts";
import { runReport } from "./report.ts";

const USAGE = `decupa — bancada de medição

  decupa gold --raw <bruto> --edited <editado> --out <gold.json>
      Deriva os cortes de um par bruto/editado.

  decupa measure --input <video|wav> --truth <verdade.json> [--model small] [--out <relatorio.json>]
      Mede o erro de fronteira de palavra do alinhamento contra fronteiras
      marcadas à mão. Portão da Fase 0: p90 <= ${GATE_P90_MS} ms.

  decupa report --out <relatorio.html> <medida1.json> [medida2.json ...]
      Junta relatórios de measure numa página só.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "gold") {
    const { values } = parseArgs({
      args: rest,
      options: {
        raw: { type: "string" },
        edited: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.raw || !values.edited || !values.out) {
      console.error("gold precisa de --raw, --edited e --out");
      return 1;
    }
    const result = await runGold({
      rawPath: values.raw,
      editedPath: values.edited,
      outPath: values.out,
    });
    console.log(
      `${result.removed.length} cortes · ${result.removedMs} ms removidos ` +
      `de ${result.rawDurationMs} ms · gravado em ${values.out}`,
    );
    return 0;
  }

  if (command === "measure") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        truth: { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.input || !values.truth) {
      console.error("measure precisa de --input e --truth");
      return 1;
    }
    const report = await runMeasure({
      input: values.input,
      truthPath: values.truth,
      model: values.model,
      outPath: values.out,
    });
    const { error } = report;
    console.log(
      `${report.tokenCount} tokens · ${error.n} fronteiras casadas, ` +
      `${error.unmatched} sem par\n` +
      `p50 ${error.p50Ms} ms · p90 ${error.p90Ms} ms · max ${error.maxMs} ms\n` +
      `portão (p90 <= ${GATE_P90_MS} ms): ${report.gatePassed ? "PASSOU" : "REPROVOU"}`,
    );
    return report.gatePassed ? 0 : 2;
  }

  if (command === "report") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { out: { type: "string" } },
      allowPositionals: true,
    });
    if (positionals.length === 0 || !values.out) {
      console.error("report precisa de --out e ao menos um relatório .json");
      return 1;
    }
    await runReport({ inputPaths: positionals, outPath: values.out });
    console.log(`relatório de ${positionals.length} trechos em ${values.out}`);
    return 0;
  }

  console.log(USAGE);
  return command === undefined ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
