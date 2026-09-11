export type Rate = { num: number; den: number };

export type Source = {
  id: string;
  path: string;
  sha256: string;
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: Rate | null;
  width: number | null;
  height: number | null;
  role: "speech" | "support" | "both";
  /** false retira a fonte do conjunto sem apagar bytes nem revisão anterior. */
  included: boolean;
  /** Nome de exibição (arquivo original); bytes salvos usam sha/UUID. */
  name: string;
  /** Sentinelas baratas de identidade; ausentes em dados antigos. */
  size?: number;
  mtimeMs?: number;
};

export type Clip = {
  id: string;
  sceneId: string;
  sourceId: string;
  sourceStartSeconds: number;
  startFrame: number;
  durationFrames: number;
};

export type Track = { kind: "Video" | "Audio"; name: string; clips: Clip[] };

export type Assembly = {
  version: 1;
  revision: number;
  name: string;
  fps: Rate;
  width: number;
  height: number;
  sources: Source[];
  tracks: Track[];
};

export type Span = {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  text: string;
};

export type VisualSpan = Span & {
  confidence: "observed" | "uncertain" | "unavailable";
  tags: string[];
};

export type Scene = {
  id: string;
  objective: string;
  rationale: string;
  speechIds: string[];
  /**
   * Seleção canônica de mídia (tarefa 3+): cada take menos seus `removed`.
   * `speechIds` segue como legado de consulta até a tarefa 6 trocar o
   * compilador; cenas sem takes (catálogo ausente na migração) ainda
   * compilam pelo legado e pedem reanálise para edição por palavra.
   */
  takes: SpeechTake[];
  support: { visualId: string; offsetFrames: number; durationFrames: number }[];
  gaps: string[];
};

/**
 * Edição pelo texto. remove/restore/protect/unprotect/include operam em
 * intervalos da fonte resolvidos por Word IDs — nunca em offsets de texto.
 * correct é overlay de grafia e não move a seleção de mídia.
 */
export type EditAction =
  | { type: "remove" | "restore" | "protect" | "unprotect"; sceneId: string; takeId: string; wordIds: string[] }
  | { type: "correct"; sourceId: string; start: number; end: number; text: string }
  | { type: "include"; sceneId: string; sourceId: string; wordIds: string[] }
  | { type: "move-scene"; sceneId: string; direction: "up" | "down" }
  | { type: "delete-scene"; sceneId: string };

/** Intervalo semiaberto em segundos: [start, end). */
export type SourceRange = { start: number; end: number };

/**
 * Palavra com identidade estável e vínculo com a fonte. O id é posicional e
 * determinístico (`${sourceId}:${sha256}:w${índice}`); correções de grafia
 * nunca mudam id, fonte ou tempos.
 */
export type Word = SourceRange & {
  id: string;
  sourceId: string;
  text: string;
  confidence: number | null;
  cutStart?: number;
  cutEnd?: number;
};

/** Fala selecionada para a montagem; a mídia retida é o take menos `removed`. */
export type SpeechTake = SourceRange & {
  id: string;
  sourceId: string;
  speechId: string | null;
  removed: SourceRange[];
  protected: SourceRange[];
};

/** Correção de grafia: overlay de texto que não move a seleção de mídia. */
export type TextCorrection = SourceRange & {
  id: string;
  sourceId: string;
  text: string;
  status: "pending" | "aligned" | "error";
  words: Word[];
  error?: string;
};

export type StageState = "pending" | "running" | "ready" | "error";

export type Preparation = {
  id: string;
  revision: number;
  mode: "prepare" | "adjust" | "preview";
  request: string;
  status: "running" | "attention" | "interrupted" | "cancelled" | "ready";
  stage: "media" | "audio" | "visual" | "proposal" | "preview";
  sources: Record<string, { media: StageState; audio: StageState; visual: StageState; error?: string }>;
  error?: string;
};

export type VisualCoverage = {
  requested: SourceRange[];
  returned: SourceRange[];
  missing: SourceRange[];
};

export type Analysis = {
  sourceId: string;
  key: string;
  speech: Span[];
  visual: VisualSpan[];
  status: "ready" | "partial" | "error";
  error?: string;
  /** Granularidade da edição; ausente em caches antigos até rederivação. */
  words: Word[];
  /** "missing" pede reanálise antes de habilitar cortes por palavra. */
  wordsStatus: "ready" | "missing";
  visualCoverage: VisualCoverage;
};

export type Proposal = {
  id: string;
  baseRevision: number;
  scenes: Scene[];
  changedSceneIds: string[];
  explanation: string;
};

export type PreviewArtifact = {
  revision: number;
  assemblySha256: string;
  relativePath: string;
  sha256: string;
};

export type Project = {
  version: 2;
  id: string;
  revision: number;
  input: { kind: "script" | "brief"; text: string; targetSeconds: number };
  assembly: Assembly;
  scenes: Scene[];
  analyses: Analysis[];
  proposal: Proposal | null;
  structureApprovedRevision: number | null;
  previewRevision: number | null;
  finalApprovedRevision: number | null;
  corrections: TextCorrection[];
  preparation: Preparation | null;
  permissions: { model: boolean; visual: boolean };
  previewArtifact: PreviewArtifact | null;
};

/** Formato do projeto antes da migração — somente leitura e migração. */
export type LegacyAnalysis = {
  sourceId: string;
  key: string;
  speech: Span[];
  visual: VisualSpan[];
  status: "ready" | "partial" | "error";
  error?: string;
};

/** Cena legada: sem takes (a migração os resolve do catálogo). */
export type LegacyScene = Omit<Scene, "takes">;

export type LegacyProject = {
  version: 1;
  id: string;
  revision: number;
  input: { kind: "script" | "brief"; text: string; targetSeconds: number };
  assembly: Omit<Assembly, "sources"> & { sources: Omit<Source, "included">[] };
  scenes: LegacyScene[];
  analyses: LegacyAnalysis[];
  proposal: Proposal | null;
  structureApprovedRevision: number | null;
  previewRevision: number | null;
  finalApprovedRevision: number | null;
};
