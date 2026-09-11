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
}
