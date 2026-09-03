import { writeFile } from "node:fs/promises";
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
export function toCondenseTranscript(transcript: Transcript): CondenseTranscript {
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
      const words: CondenseWord[] = ordered.map((t) => ({
        text: t.text,
        start: t.startMs / 1000,
        end: t.endMs / 1000,
      }));
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
): Promise<CondenseTranscript> {
  const converted = toCondenseTranscript(transcript);
  await writeFile(outPath, `${JSON.stringify(converted, null, 2)}\n`, "utf8");
  return converted;
}
