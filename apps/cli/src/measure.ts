import { readFile, writeFile } from "node:fs/promises";
import { boundaryError, type BoundaryError } from "@decupa/metrics";
import { transcribe, wordBoundaries } from "@decupa/transcript";

/** Limiares do portão da Fase 0. Ver a spec. */
export const GATE_P90_MS = 50;
export const GATE_MAX_UNMATCHED_RATIO = 0.05;

export interface MeasureReport {
  input: string;
  language: string;
  model: string;
  tokenCount: number;
  boundaries: number[];
  truthBoundaries: number[];
  error: BoundaryError;
  gatePassed: boolean;
  /**
   * Procedência do arquivo de verdade. Só "blind-keyboard" (gravado pelo
   * `decupa mark`) prova que as fronteiras não vieram da própria predição.
   * Verdade derivada do alinhador mede zero por construção.
   */
  truthMethod: string | null;
  measuredAt: string;
}

/** Procedência declarada no arquivo de verdade, ou null se não houver. */
export function loadTruthMethod(json: string): string | null {
  const parsed = JSON.parse(json) as { method?: unknown };
  return typeof parsed.method === "string" ? parsed.method : null;
}

/** Arquivo de verdade: `{ "boundariesMs": [120, 260, 520, ...] }`, em ms. */
export function loadTruthBoundaries(json: string): number[] {
  const parsed = JSON.parse(json) as { boundariesMs?: unknown };
  const raw = parsed.boundariesMs;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "number")) {
    throw new Error("arquivo de verdade precisa de boundariesMs: number[]");
  }
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}

export function evaluateGate(error: BoundaryError): boolean {
  const total = error.n + error.unmatched;
  if (total === 0 || error.n === 0) return false;
  if (error.unmatched / total > GATE_MAX_UNMATCHED_RATIO) return false;
  return error.p90Ms <= GATE_P90_MS;
}

export async function runMeasure(opts: {
  input: string;
  truthPath: string;
  language?: string;
  model?: string;
  toleranceMs?: number;
  outPath?: string;
}): Promise<MeasureReport> {
  const language = opts.language ?? "pt";
  const model = opts.model ?? "small";

  const truthJson = await readFile(opts.truthPath, "utf8");
  const truthBoundaries = loadTruthBoundaries(truthJson);
  const truthMethod = loadTruthMethod(truthJson);
  const transcript = await transcribe({ input: opts.input, language, model });
  const boundaries = wordBoundaries(transcript);

  const error = boundaryError({
    predicted: boundaries,
    truth: truthBoundaries,
    toleranceMs: opts.toleranceMs ?? 500,
  });

  const report: MeasureReport = {
    input: opts.input,
    language,
    model,
    tokenCount: transcript.tokens.length,
    boundaries,
    truthBoundaries,
    error,
    gatePassed: evaluateGate(error),
    truthMethod,
    measuredAt: new Date().toISOString(),
  };

  if (opts.outPath) {
    await writeFile(opts.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}
