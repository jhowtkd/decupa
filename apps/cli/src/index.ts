#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { runGold } from "./gold.ts";
import { runMark } from "./mark.ts";
import { runMarkWeb } from "./mark-web/server.ts";
import { GATE_P90_MS, runMeasure } from "./measure.ts";
import { BLIND_METHODS, isBlindMethod, runReport } from "./report.ts";

const USAGE = `decupa — bancada de medição

  decupa doctor — checa o ambiente (binários, sidecars, motor, patch, chave) e diz o que consertar

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

  decupa condense-prep --input <video|wav> --out <transcript.json> [--model small] [--language pt] [--no-trim]
      Transcreve com o WhisperX do Decupa e grava no formato que o motor de
      condense (video-agent-kit-plugin) espera. Apara o fim de palavra que o
      alinhador esticou sobre o silêncio — use --no-trim para desligar.

  decupa triage --index <speech_index.json> --video <vídeo> --out <pasta> [--target 90] [--provider zai|gemini|minimax|custom] [--model <id>] [--max-tokens 16000]
      Decide o que é conteúdo do vídeo e o que não é, e devolve o keep-list
      pronto pro \`condense.py plan\`. Cada alegação do modelo é conferida
      contra o índice antes de virar corte. --target liga o passe de
      densidade; sem ele, só estrutura. O thinking do GLM consome orçamento
      antes da resposta: quando ele come tudo, o orçamento dobra sozinho até
      64k; --max-tokens sobe o ponto de partida.

  decupa limpar --input <vídeo> [--port 7788] [--provider zai|gemini|minimax|custom]
      Abre a tela de limpeza no navegador: lê o corte como prosa, desliga o
      que não quer, exporta MP4, EDL, legendas ou transcrição.

  decupa montar --project <pasta> [--input <arquivo>] [--port 7788]
           [--allow-paid-model] [--allow-paid-visual]
      Abre o fluxo de montagem multiarquivo. --input acrescenta uma fonte;
      omitir --input reabre o projeto já gravado na pasta.
      Pagos ficam desligados; as flags só autorizam o cliente, não disparam chamada.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "doctor") {
    const { runDoctor, renderDoctor } = await import("./doctor.ts");
    const lines = await runDoctor();
    console.log(renderDoctor(lines));
    return lines.every((l) => l.ok) ? 0 : 1;
  }

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
        language: { type: "string" },
        "no-trim": { type: "boolean" },
      },
    });
    if (!values.input || !values.out) {
      console.error("condense-prep precisa de --input e --out");
      return 1;
    }
    const { runCondensePrep } = await import("./condense/run.ts");
    const result = await runCondensePrep({
      input: values.input,
      out: values.out,
      model: values.model,
      language: values.language,
      trim: !values["no-trim"],
    });
    console.log(`${result.segments} segmentos, ${result.words} palavras -> ${values.out}`);
    if (result.trimmedSeconds > 0) {
      console.log(
        `fim de palavra aparado: ${result.trimmedSeconds.toFixed(1)}s de silêncio devolvidos como pausa`,
      );
    }
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

  if (command === "triage") {
    const { values } = parseArgs({
      args: rest,
      options: {
        index: { type: "string" },
        video: { type: "string" },
        out: { type: "string" },
        target: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        "max-tokens": { type: "string" },
      },
    });
    if (!values.index || !values.video || !values.out) {
      console.error("triage precisa de --index, --video e --out");
      return 1;
    }
    const { resolveProvider } = await import("@decupa/triage");
    let provider;
    try {
      provider = resolveProvider(values.provider);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const { runTriage } = await import("./triage.ts");
    const result = await runTriage({
      indexPath: values.index,
      videoPath: values.video,
      outDir: values.out,
      targetSeconds: values.target ? Number(values.target) : undefined,
      modelName: values.model,
      provider,
      maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
    });
    const rejected = result.verdicts.filter((v) => !v.accepted).length;
    console.log(`keep-list: ${result.keepList}`);
    console.log(`${result.verdicts.length - rejected} alegação(ões) aplicada(s), ${rejected} rejeitada(s) · ${result.reportPath}`);
    if (rejected > 0) console.log("Leia as rejeitadas no relatório antes de seguir.");
    return 0;
  }

  if (command === "limpar") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        port: { type: "string" },
        provider: { type: "string" },
      },
    });
    if (!values.input) {
      console.error("limpar precisa de --input");
      return 1;
    }
    const { startApp } = await import("./app/server.ts");
    const app = await startApp({
      input: values.input,
      port: values.port ? Number(values.port) : undefined,
      provider: values.provider,
    });
    const url = `http://127.0.0.1:${app.port}`;
    console.log(`tela de limpeza aberta em ${url}`);
    console.log("Ctrl+C para encerrar");
    // Abre o navegador; falhar aqui não é motivo para derrubar o servidor.
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    await new Promise<void>((resolve) => {
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        await app.close();
        resolve();
        process.exit(0);
      };
      process.once("SIGINT", () => { void shutdown(); });
      process.once("SIGTERM", () => { void shutdown(); });
    });
    return 0;
  }

  if (command === "montar") {
    const { values } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        input: { type: "string" },
        port: { type: "string" },
        "allow-paid-model": { type: "boolean" },
        "allow-paid-visual": { type: "boolean" },
      },
    });
    if (!values.project) {
      console.error("montar precisa de --project");
      return 1;
    }
    const { startApp } = await import("./app/server.ts");
    const app = await startApp({
      projectDir: values.project,
      inputs: values.input ? [values.input] : undefined,
      port: values.port ? Number(values.port) : undefined,
      allowPaidModel: values["allow-paid-model"] === true,
      allowPaidVisual: values["allow-paid-visual"] === true,
    });
    const url = `http://127.0.0.1:${app.port}`;
    console.log(`tela de montagem aberta em ${url}`);
    console.log("Ctrl+C para encerrar");
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    await new Promise<void>((resolve) => {
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        await app.close();
        resolve();
        process.exit(0);
      };
      process.once("SIGINT", () => { void shutdown(); });
      process.once("SIGTERM", () => { void shutdown(); });
    });
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
