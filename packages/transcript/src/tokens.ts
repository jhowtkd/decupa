import type { RawWord, Transcript, TranscriptToken } from "./types.ts";

/** `w_000318` — índice global, seis dígitos. Ver Global Constraints. */
export function tokenId(index: number): string {
  return `w_${String(index).padStart(6, "0")}`;
}

export function toTokens(words: RawWord[]): TranscriptToken[] {
  return words.map((word, index) => ({
    id: tokenId(index),
    text: word.text,
    startMs: Math.round(word.startMs),
    endMs: Math.round(word.endMs),
    confidence: word.confidence,
    sentenceIndex: word.sentenceIndex,
  }));
}

/**
 * Só os ataques de palavra, ordenados e sem repetição.
 *
 * Onde a palavra começa é nítido no ouvido; onde termina não é — a vogal
 * decai, tem aspiração e coarticulação. Marcação humana confiável é de ataque,
 * e comparar marcação de ataque contra a lista completa de fronteiras casaria
 * a marca com o final da palavra anterior sempre que houvesse pausa,
 * subestimando o erro.
 */
export function wordOnsets(transcript: Transcript): number[] {
  return [...new Set(transcript.tokens.map((token) => token.startMs))].sort(
    (a, b) => a - b,
  );
}

/** Todas as fronteiras de palavra — ataques e finais —, ordenadas e sem repetição. */
export function wordBoundaries(transcript: Transcript): number[] {
  const unique = new Set<number>();
  for (const token of transcript.tokens) {
    unique.add(token.startMs);
    unique.add(token.endMs);
  }
  return [...unique].sort((a, b) => a - b);
}
