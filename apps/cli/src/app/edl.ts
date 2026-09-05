export interface EdlClip {
  /** segundos na fonte */
  start: number;
  end: number;
}

/** Segundos → `HH:MM:SS:FF`. */
export function timecode(seconds: number, fps: number): string {
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
 * Escopo deliberadamente estreito no v1: frame rate inteiro, non-drop-frame,
 * um canal de vídeo, um reel. Drop-frame 29,97 e faixas de áudio separadas são
 * projeto próprio; deixá-los em aberto faria o EDL virar um segundo projeto no
 * meio do primeiro.
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
  if (!Number.isInteger(fps)) {
    throw new Error(
      `frame rate ${fps} não é inteiro. O EDL do v1 só gera non-drop-frame com fps ` +
      "inteiro; para 29.97 o timecode sairia errado em silêncio.",
    );
  }

  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  let recordFrames = 0;

  clips.forEach((clip, i) => {
    const durationFrames = Math.round(clip.end * fps) - Math.round(clip.start * fps);
    const recordIn = recordFrames / fps;
    const recordOut = (recordFrames + durationFrames) / fps;
    lines.push(
      `${String(i + 1).padStart(3, "0")}  AX       V     C        ` +
      `${timecode(clip.start, fps)} ${timecode(clip.end, fps)} ` +
      `${timecode(recordIn, fps)} ${timecode(recordOut, fps)}`,
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
