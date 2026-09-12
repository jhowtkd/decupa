export interface EdlClip {
  /** segundos na fonte */
  start: number;
  end: number;
}

function framesToDropFrameTimecode(frameNumber: number): string {
  const FRAMES_PER_MINUTE = 1798;
  const FRAMES_PER_10_MINUTES = 17982;
  let frames = frameNumber;
  if (frames < 0) frames = 0;
  const d = Math.floor(frames / FRAMES_PER_10_MINUTES);
  const m = frames % FRAMES_PER_10_MINUTES;
  if (m > 1) {
    frames += 18 * d + 2 * Math.floor((m - 2) / FRAMES_PER_MINUTE);
  } else {
    frames += 18 * d;
  }
  const f = frames % 30;
  const s = Math.floor(frames / 30) % 60;
  const min = Math.floor(Math.floor(frames / 30) / 60) % 60;
  const h = Math.floor(Math.floor(Math.floor(frames / 30) / 60) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(s)};${pad(f)}`;
}

/** Segundos → `HH:MM:SS:FF` ou `HH:MM:SS;FF` (drop-frame). */
export function timecode(seconds: number, fps: number, dropFrame = false): string {
  if (dropFrame) {
    const totalFrames = Math.round(seconds * fps);
    return framesToDropFrameTimecode(totalFrames);
  }
  const totalFrames = Math.round(seconds * fps);
  const frame = totalFrames % fps;
  const whole = Math.floor(totalFrames / fps);
  const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, frame];
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Lista de cortes no formato CMX3600, que Premiere e DaVinci importam sem
 * plugin. Entrega os cortes na timeline da ferramenta onde o editor já
 * trabalha, com o material original intacto — ao contrário do MP4, que ninguém
 * consegue mais ajustar.
 *
 * Suporta frame rates inteiros (non-drop-frame) e NTSC 29,97 (drop-frame).
 */
export function buildEdl(opts: {
  clips: EdlClip[];
  fps: number;
  title: string;
  /** Nome do arquivo de origem, para o relink na NLE. Default: o título. */
  sourceName?: string;
}): string {
  const { clips, fps, title } = opts;
  const sourceName = opts.sourceName ?? title;
  if (clips.length === 0) throw new Error("nenhum clipe para exportar");

  const isDropFrame = Math.abs(fps - 29.97) < 0.01;
  if (!Number.isInteger(fps) && !isDropFrame) {
    throw new Error(
      `frame rate ${fps} não é suportado no EDL. Suportados: fps inteiro (non-drop-frame) ` +
      "ou 29.97 (drop-frame); para outros fracionários utilize exportação OTIO.",
    );
  }

  const lines = [
    `TITLE: ${title}`,
    isDropFrame ? "FCM: DROP FRAME" : "FCM: NON-DROP FRAME",
    "",
  ];
  let recordFrames = 0;

  clips.forEach((clip, i) => {
    const durationFrames = Math.round(clip.end * fps) - Math.round(clip.start * fps);
    const recordIn = recordFrames / fps;
    const recordOut = (recordFrames + durationFrames) / fps;
    lines.push(
      `${String(i + 1).padStart(3, "0")}  AX       V     C        ` +
      `${timecode(clip.start, fps, isDropFrame)} ${timecode(clip.end, fps, isDropFrame)} ` +
      `${timecode(recordIn, fps, isDropFrame)} ${timecode(recordOut, fps, isDropFrame)}`,
    );
    // `AX` no campo de reel significa "sem reel atribuído", e o campo tem só 8
    // caracteres — não cabe nome de arquivo. `* FROM CLIP NAME:` é como o
    // CMX3600 carrega a origem, e é o que a NLE lê para relinkar. Sem esta
    // linha o EDL abre, mas apontar cada corte para o arquivo é trabalho
    // manual.
    lines.push(`* FROM CLIP NAME: ${sourceName}`);
    recordFrames += durationFrames;
  });

  return `${lines.join("\n")}\n`;
}
