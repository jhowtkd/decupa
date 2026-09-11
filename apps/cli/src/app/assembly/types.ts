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
  support: { visualId: string; offsetFrames: number; durationFrames: number }[];
  gaps: string[];
};

export type Analysis = {
  sourceId: string;
  key: string;
  speech: Span[];
  visual: VisualSpan[];
  status: "ready" | "partial" | "error";
  error?: string;
};

export type Proposal = {
  id: string;
  baseRevision: number;
  scenes: Scene[];
  changedSceneIds: string[];
  explanation: string;
};

export type Project = {
  version: 1;
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
};
