export type TokenId = string;

/** Palavra alinhada. Tempo sempre em ms inteiro. */
export interface TranscriptToken {
  id: TokenId;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  sentenceIndex: number;
}

export interface Transcript {
  language: string;
  tokens: TranscriptToken[];
}

/** Formato cru vindo do sidecar Python, antes de ganhar ID. */
export interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  sentenceIndex: number;
}
