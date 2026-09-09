export interface SrtWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SrtClip {
  /** segundos na fonte */
  start: number;
  end: number;
}

/** ms → `HH:MM:SS,mmm`, o formato SRT (vírgula decimal, não ponto). */
export function srtTimestamp(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1_000) % 60;
  const rest = ms % 1_000;
  const pad = (n: number, size = 2): string => String(n).padStart(size, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

/**
 * Legendas do corte: para cada clipe do plano, as palavras do WhisperX que
 * caem dentro, remarcadas na timeline de saída. O corte remove tempo entre
 * clipes — a legenda tem que sofrer o mesmo deslocamento, senão dessincroniza
 * exatamente nos pontos onde cortou.
 */
export function buildSrt(opts: {
  clips: SrtClip[];
  words: SrtWord[];
  maxChars?: number;
  maxMs?: number;
  gapMs?: number;
}): string {
  const { clips, words } = opts;
  if (clips.length === 0) throw new Error("nenhum clipe para exportar");
  const maxChars = opts.maxChars ?? 42;
  const maxMs = opts.maxMs ?? 5_000;
  const gapMs = opts.gapMs ?? 700;

  const cues: { startMs: number; endMs: number; text: string }[] = [];
  let at = 0; // cursor da timeline de saída, em ms

  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const clipStartMs = Math.round(clip.start * 1_000);
    const clipEndMs = Math.round(clip.end * 1_000);
    const inClip = words.filter((word) => word.startMs >= clipStartMs && word.startMs < clipEndMs);

    let cue: SrtWord[] = [];
    let cueChars = 0;
    const flush = (): void => {
      if (cue.length === 0) return;
      cues.push({
        startMs: at + cue[0]!.startMs - clipStartMs,
        endMs: at + cue[cue.length - 1]!.endMs - clipStartMs,
        text: cue.map((word) => word.text).join(" "),
      });
      cue = [];
      cueChars = 0;
    };

    for (const word of inClip) {
      if (cue.length > 0) {
        const gap = word.startMs - cue[cue.length - 1]!.endMs;
        const dur = cue[cue.length - 1]!.endMs - cue[0]!.startMs;
        // Quebra nos mesmos sinais que um leitor percebe: pausa comprida,
        // cue longa demais, linha que não cabe.
        if (gap > gapMs || dur > maxMs || cueChars + word.text.length + 1 > maxChars) flush();
      }
      cue.push(word);
      cueChars += word.text.length + 1;
    }
    flush();
    at += clipEndMs - clipStartMs;
  }

  if (cues.length === 0) {
    throw new Error("nenhuma palavra do transcript cai dentro dos clipes do plano");
  }
  return cues
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.startMs)} --> ${srtTimestamp(c.endMs)}\n${c.text}\n`)
    .join("\n");
}
