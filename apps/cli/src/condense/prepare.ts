import { writeFile } from "node:fs/promises";
import { trimTrailingSilence } from "@decupa/acoustics";
import type { Interval } from "@decupa/core";
import type { Transcript, TranscriptToken } from "@decupa/transcript";

export interface CondenseWord {
  text: string;
  start: number;
  end: number;
}

export interface CondenseSegment {
  start: number;
  end: number;
  text: string;
  words: CondenseWord[];
}

export interface CondenseTranscript {
  segments: CondenseSegment[];
}

/**
 * Converte o Transcript do Decupa (ms, tokens palavra-a-palavra) para o
 * formato que `condense_index` espera (segundos, agrupado por segmento).
 *
 * O motor lê qualquer JSON com `segments[].words[].{text,start,end}` — ver
 * `mcp/ve_tools/subtitle.py:load_timed_segments` no motor vendorizado. Não
 * depende da ASR deles (Volcano Engine): o `timing_source` que o motor deriva
 * internamente vira "word_timestamps" sempre que `words` está presente, que é
 * exatamente o que desbloqueia o modo `drop_fillers` com precisão de palavra.
 */
export function toCondenseTranscript(
  transcript: Transcript,
  opts: { silences?: Interval[] } = {},
): CondenseTranscript {
  const bySentence = new Map<number, TranscriptToken[]>();
  for (const token of transcript.tokens) {
    const group = bySentence.get(token.sentenceIndex);
    if (group) group.push(token);
    else bySentence.set(token.sentenceIndex, [token]);
  }

  const segments: CondenseSegment[] = [...bySentence.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tokens]) => {
      const ordered = [...tokens].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
      const words: CondenseWord[] = ordered.map((t) => {
        // Fim vindo do alinhador não é confiável quando há silêncio depois:
        // ele estica a última palavra do segmento sobre a pausa inteira.
        // Com o envelope em mãos, o fim volta para onde o som realmente para,
        // e a pausa volta a existir para o motor de corte enxergar.
        const endMs = opts.silences
          ? trimTrailingSilence({ silences: opts.silences, startMs: t.startMs, endMs: t.endMs })
          : t.endMs;
        return { text: t.text, start: t.startMs / 1000, end: endMs / 1000 };
      });
      return {
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        text: ordered.map((t) => t.text).join(" "),
        words,
      };
    });

  return { segments };
}

export async function writeCondenseTranscript(
  transcript: Transcript,
  outPath: string,
  opts: { silences?: Interval[] } = {},
): Promise<CondenseTranscript> {
  const converted = toCondenseTranscript(transcript, opts);
  await writeFile(outPath, `${JSON.stringify(converted, null, 2)}\n`, "utf8");
  return converted;
}
