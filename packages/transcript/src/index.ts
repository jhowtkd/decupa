export type { RawWord, TokenId, Transcript, TranscriptToken } from "./types.ts";
export { toTokens, tokenId, wordBoundaries, wordOnsets } from "./tokens.ts";
export { alignText, transcribe, validateAlignmentCoverage } from "./transcribe.ts";
export type { AlignTextDeps, SidecarResult, TranscribeDeps, SpeechWorkerRequest } from "./transcribe.ts";
export { runSpeechJob } from "./resident.ts";
export { createResidentSpeechClient } from "./client.ts";
export type { ResidentSpeechClient, SpeechSpawner } from "./client.ts";
