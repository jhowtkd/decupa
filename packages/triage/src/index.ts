export type { ClaimSource, DropReason, StructureClaim, Verdict } from "./claims.ts";
export type {
  DensityCandidate, DensityRequest, InspectRequest, InspectVerdict,
  StructureRequest, TriageModel,
} from "./model.ts";
export type { IndexUnit, SpeechIndex, TopicRun, TrimCandidate } from "./speech-index.ts";
export type { CacheKeyParts } from "./cache.ts";
export type { InspectFlag, InspectOutcome } from "./inspect.ts";
export type { ReportInput } from "./report.ts";
export type { ZaiUsage } from "./zai.ts";
export type { VisualFlagCode, VisualSample, VisualUnitFlags } from "./visual.ts";
export type { Provider } from "./provider.ts";

export { acceptedDropIds, verifyClaims } from "./claims.ts";
export { resolveProvider } from "./provider.ts";
export { applyDensityBudget, DENSITY_INSTRUCTIONS } from "./density.ts";
export { parseDensityCandidates, parseInspectVerdict, parseStructureClaims, readChoice, ZAI_DEFAULT_BASE, ZAI_DEFAULT_MODEL, ZaiClient, ZaiTriageModel } from "./zai.ts";
export { keepListFrom } from "./keeplist.ts";
export { FakeTriageModel } from "./model.ts";
export { applyInspect, flagsWithoutSubstitute, normalizeInspectVerdict } from "./inspect.ts";
export { buildUnitsBlock, INSPECT_INSTRUCTIONS, PROMPT_VERSION, STRUCTURE_INSTRUCTIONS } from "./prompt.ts";
export { renderReport } from "./report.ts";
export { cacheKey, readCache, writeCache } from "./cache.ts";
export { looksLikeDeadAir, parseSpeechIndex, topicSpan, unitByIdOrThrow, unitsById } from "./speech-index.ts";
export {
  MOTOR_DUPLICATE_THRESHOLD,
  RESTATEMENT_THRESHOLD,
  SHORT_JACCARD_THRESHOLD,
  SHORT_UNIT_TOKEN_LIMIT,
  characterSimilarity,
  headOverlap,
  isRestatement,
  shortUnitSimilarity,
  similarity,
} from "./similarity.ts";
export { hasDirectorCue } from "./cues.ts";
export { MAX_INDEX_GAP, retakeClaims } from "./retakes.ts";
export { mechanicalClaims, mechanicalKeepList } from "./mechanical.ts";
export {
  HAND_ON_FACE_AMBIGUOUS,
  HAND_ON_FACE_BAD,
  LOOKS_AWAY_AMBIGUOUS,
  LOOKS_AWAY_BAD,
  NO_FACE_AMBIGUOUS,
  NO_FACE_BAD,
  flagsFor,
  nearestSample,
  parseVisualIndex,
  sampleLooksBadAtJoin,
} from "./visual.ts";
