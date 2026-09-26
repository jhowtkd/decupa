export type Rate = { num: number; den: number };

export interface MediaInfo {
  path: string;
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  frameRate: Rate | null;
  averageFrameRate: Rate | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  /** Etiqueta de timecode embutida na mídia (ex.: "01:00:00:00"); null se ausente. */
  timecode: string | null;
  /** Rotação de exibição em graus (múltiplo de 90) lida do display matrix; null se ausente/ambígua. */
  rotation: number | null;
}
