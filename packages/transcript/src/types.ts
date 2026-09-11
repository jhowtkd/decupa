export type TokenId = string;

/** Palavra alinhada. Tempo sempre em ms inteiro. */
export interface TranscriptToken {
  id: TokenId;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  sentenceIndex: number;
  /** Corte refinado por snap acústico, quando calculado; leitores ignoram. */
  cutStartMs?: number;
  cutEndMs?: number;
}

export interface Transcript {
  language: string;
  tokens: TranscriptToken[];
  /** Textos que o alinhador não vinculou a tempo — nunca com tempo inventado. */
  unaligned?: string[];
}

/** Formato cru vindo do sidecar Python, antes de ganhar ID. */
export interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  sentenceIndex: number;
}
