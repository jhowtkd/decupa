import { detectSilence } from "@decupa/acoustics";
import type { Interval } from "@decupa/core";
import { transcribe, type Transcript } from "@decupa/transcript";
import { writeCondenseTranscript } from "./prepare.ts";

export interface CondensePrepDeps {
  transcribe: (o: { input: string; language?: string; model?: string }) => Promise<Transcript>;
  detectSilence: (o: { input: string; thresholdDb: number; minDurationMs: number }) => Promise<Interval[]>;
}

export interface CondensePrepResult {
  segments: number;
  words: number;
  /** Silêncio devolvido como pausa ao aparar o fim de palavra. */
  trimmedSeconds: number;
}

/**
 * O comando `condense-prep` como função: transcreve, apara o fim de palavra que
 * o alinhador esticou sobre o silêncio, e grava no formato do motor.
 *
 * Dependências injetadas porque o valor de teste está na fiação — idioma que
 * passa adiante, `--no-trim` que realmente pula o detector — e não em rodar
 * WhisperX de novo.
 */
export async function runCondensePrep(
  opts: { input: string; out: string; language?: string; model?: string; trim?: boolean },
  deps: CondensePrepDeps = { transcribe, detectSilence },
): Promise<CondensePrepResult> {
  const transcript = await deps.transcribe({
    input: opts.input,
    language: opts.language ?? "pt",
    model: opts.model,
  });

  // O alinhador estica a última palavra de um segmento sobre o silêncio que vem
  // depois. Sem consertar isso, o motor de corte fica cego para essas pausas e
  // elas sobrevivem inteiras dentro do clipe.
  const silences = opts.trim === false
    ? undefined
    : await deps.detectSilence({ input: opts.input, thresholdDb: -35, minDurationMs: 150 });

  const before = transcript.tokens.reduce((n, t) => n + (t.endMs - t.startMs), 0);
  const converted = await writeCondenseTranscript(transcript, opts.out, { silences });
  const after = converted.segments.reduce(
    (n, s) => n + s.words.reduce((m, w) => m + (w.end - w.start) * 1000, 0),
    0,
  );

  return {
    segments: converted.segments.length,
    words: converted.segments.reduce((n, s) => n + s.words.length, 0),
    trimmedSeconds: silences ? (before - after) / 1000 : 0,
  };
}
