import type { Recipe } from "../templates/types.ts";
export type Rate = { num: number; den: number };

/**
 * Etiqueta de timecode da mídia tal como lida (ex.: "01:00:00:00" ou
 * "01:00:00;00" drop-frame). `frames` é o número de quadros decorridos
 * desde 00:00 na taxa da fonte — já com a contagem drop-frame aplicada;
 * null quando a etiqueta existe mas não converte (inválida).
 */
export type SourceTimecode = {
  raw: string;
  frames: number | null;
  dropFrame: boolean;
};

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
  /** Timecode de origem da mídia; ausente em fontes sem etiqueta. */
  timecode?: SourceTimecode | null;
  /** Rotação de exibição em graus (0/90/180/270); ausente/0 = sem rotação. */
  rotation?: number | null;
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
  /**
   * Fonte cujas dimensões de exibição/fps definiram o canvas; `null` =
   * decidido sem fonte (manual ou legado sem vídeo), `undefined` = ainda
   * não escolhido — a próxima fonte com vídeo pode definir (ver
   * applyCanvasPolicy).
   */
  canvasSourceId?: string | null;
  /** Escolha de formato feita pelo usuário — nunca é sobrescrita em import. */
  canvasManual?: boolean;
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

export type AnimationNote = {
  id: string; description: string; destination: "Resolve" | "After Effects";
  reference?: {templateId:string; revision:number; start:number; end:number};
};

export type Scene = {
  animationNotes?: AnimationNote[];
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
  /** Evidência visual que fundamenta a cena (observed/uncertain; nunca unavailable). */
  visualEvidenceIds: string[];
  support: { visualId: string; offsetFrames: number; durationFrames: number }[];
  gaps: string[];
};

/**
 * Edição pelo texto. remove/restore/protect/unprotect/include operam em
 * intervalos da fonte resolvidos por Word IDs — nunca em offsets de texto.
 * correct é overlay de grafia e não move a seleção de mídia.
 */
export type EditAction =
  | { type: "set-support"; sceneId: string; support: Scene["support"] }
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
  /** Estado visível pontual, ex. áudio pronto enquanto a imagem ainda analisa. */
  note?: string;
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

export type DecisionReport = {
  mode: "off" | "observe" | "hybrid";
  status: "not-run" | "completed" | "fallback";
  model: string | null;
  elapsedMs: number;
  reason?: string;
  cuts: {id:string; sceneId:string; takeId:string; applied:boolean; score:number|null}[];
  supports?: {sceneId:string; candidateId:string|null; outcome:"selected"|"none"|"fallback"; reason:string}[];
};

export type TemplateReport = {ruleId:string;status:"applied"|"adapted"|"unavailable";reason:string}[];

export type Proposal = {
  template?: Recipe | null;
  templateReport?: TemplateReport;
  decisionReport?: DecisionReport;
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
  template?: Recipe | null;
  version: 2;
  id: string;
  revision: number;
  input: { kind: "script" | "brief"; text: string; targetSeconds: number };
  assembly: Assembly;
  scenes: Scene[];
  analyses: Analysis[];
  proposal: Proposal | null;
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

/** Cena legada: sem takes nem evidência (a migração resolve do catálogo). */
export type LegacyScene = Omit<Scene, "takes" | "visualEvidenceIds">;

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
