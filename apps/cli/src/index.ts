#!/usr/bin/env node
import { parseArgs } from "node:util";
import { transcribe } from "@decupa/transcript";
import { writeCondenseTranscript } from "./condense/prepare.ts";
import { runGold } from "./gold.ts";
import { runMark } from "./mark.ts";
import { runMarkWeb } from "./mark-web/server.ts";
import { GATE_P90_MS, runMeasure } from "./measure.ts";
import { BLIND_METHODS, isBlindMethod, runReport } from "./report.ts";

const USAGE = `decupa — bancada de medição

  decupa gold --raw <bruto> --edited <editado> --out <gold.json>
      Deriva os cortes de um par bruto/editado.

  decupa mark --input <video|wav> --out <verdade.json> [--web] [--port 7777]
      Marca fronteiras de palavra sem nunca exibir a predição do alinhador.
      --web abre um marcador no navegador com vídeo e forma de onda (é o
      recomendado); sem ele, cai no modo terminal, só de ouvido.

  decupa measure --input <video|wav> --truth <verdade.json> [--model small] [--onsets-only] [--out <relatorio.json>]
      Mede o erro de fronteira de palavra do alinhamento contra fronteiras
      marcadas às cegas. Use --onsets-only quando a marcação for só de ataques
      de palavra. Portão da Fase 0: p90 <= ${GATE_P90_MS} ms.

  decupa report --out <relatorio.html> <medida1.json> [medida2.json ...]
      Junta relatórios de measure numa página só.

  decupa condense-prep --input <video|wav> --out <transcript.json> [--model small]
      Transcreve com o WhisperX do Decupa e grava no formato que o motor de
      condense (video-agent-kit-plugin) espera.
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
        "onsets-only": { type: "boolean" },
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
      onsetsOnly: values["onsets-only"] ?? false,
    });
    const { error } = report;
    console.log(
      `${report.tokenCount} tokens · ${error.n} fronteiras casadas, ` +
      `${error.unmatched} sem par\n` +
      `p50 ${error.p50Ms} ms · p90 ${error.p90Ms} ms · max ${error.maxMs} ms\n` +
      `portão (p90 <= ${GATE_P90_MS} ms): ${report.gatePassed ? "PASSOU" : "REPROVOU"}`,
    );
    if (!isBlindMethod(report.truthMethod)) {
      console.error(
        `\nAVISO: a verdade em ${values.truth} tem procedência ` +
        `"${report.truthMethod ?? "não declarada"}", que não é uma das cegas ` +
        `(${BLIND_METHODS.join(", ")}).\n` +
        `Se essas fronteiras saíram da própria transcrição, este número não ` +
        `mede nada — erro zero é consequência aritmética, não qualidade.\n` +
        `Refaça com: decupa mark --input ${values.input} --out ${values.truth}`,
      );
      return 3;
    }
    return report.gatePassed ? 0 : 2;
  }

  if (command === "mark") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        out: { type: "string" },
        preview: { type: "string" },
        start: { type: "string" },
        web: { type: "boolean" },
        port: { type: "string" },
      },
    });
    if (!values.input || !values.out) {
      console.error("mark precisa de --input e --out");
      return 1;
    }
    if (values.web) {
      const result = await runMarkWeb({
        input: values.input,
        outPath: values.out,
        port: values.port ? Number(values.port) : undefined,
      });
      console.log(
        `${result.boundariesMs.length} fronteiras marcadas às cegas · ` +
        `gravado em ${result.outPath}`,
      );
      return 0;
    }
    const truth = await runMark({
      input: values.input,
      outPath: values.out,
      previewMs: values.preview ? Number(values.preview) : undefined,
      startMs: values.start ? Number(values.start) : undefined,
    });
    console.log(
      `\n${truth.boundariesMs.length} fronteiras marcadas às cegas · ` +
      `gravado em ${values.out}`,
    );
    return 0;
  }

  if (command === "condense-prep") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
      },
    });
    if (!values.input || !values.out) {
      console.error("condense-prep precisa de --input e --out");
      return 1;
    }
    const transcript = await transcribe({ input: values.input, model: values.model });
    const converted = await writeCondenseTranscript(transcript, values.out);
    const words = converted.segments.reduce((n, s) => n + s.words.length, 0);
    console.log(
      `${converted.segments.length} segmentos, ${words} palavras -> ${values.out}`,
    );
    return 0;
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Uma falha esperada (arquivo ausente, terminal errado) deve sair com uma
  // frase, não com pilha de chamadas. A pilha só aparece se DECUPA_DEBUG=1.
  console.error(error instanceof Error ? `erro: ${error.message}` : `erro: ${String(error)}`);
  if (process.env.DECUPA_DEBUG === "1" && error instanceof Error) {
    console.error(error.stack);
  }
  process.exitCode = 1;
}
