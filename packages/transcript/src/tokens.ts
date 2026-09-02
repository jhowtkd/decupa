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

/** Todas as fronteiras de palavra, ordenadas e sem repetição. */
export function wordBoundaries(transcript: Transcript): number[] {
  const unique = new Set<number>();
  for (const token of transcript.tokens) {
    unique.add(token.startMs);
    unique.add(token.endMs);
  }
  return [...unique].sort((a, b) => a - b);
}
