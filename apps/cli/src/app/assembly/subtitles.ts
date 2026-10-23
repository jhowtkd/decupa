import { createHash } from "node:crypto";
import type { Clip, Project } from "./types.ts";
import { effectiveWords, retainedRanges, subtractRanges } from "./words.ts";

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleResult {
  cues: SubtitleCue[];
  vtt: string;
  srt: string;
}

/** Mesma política de quebra da Limpar (srt.ts): linha curta, cue curto, pausa. */
const MAX_CHARS = 42;
const MAX_MS = 5_000;
const GAP_MS = 700;
/** Fronteira de frase também quebra o cue — legenda acompanha a sentença. */
const SENTENCE_END = /[.?!…]$/u;

function pad(n: number, size = 2): string {
  return String(n).padStart(size, "0");
}

function parts(totalMs: number): [number, number, number, number] {
  const ms = Math.max(0, Math.round(totalMs));
  return [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1_000) % 60, ms % 1_000];
}

/** ms → `HH:MM:SS.mmm`, o formato VTT (ponto decimal). */
export function vttTimestamp(totalMs: number): string {
  const [h, m, s, ms] = parts(totalMs);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** ms → `HH:MM:SS,mmm`, o formato SRT (vírgula decimal). */
export function srtTimestamp(totalMs: number): string {
  const [h, m, s, ms] = parts(totalMs);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function formatVtt(cues: SubtitleCue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${vttTimestamp(c.startMs)} --> ${vttTimestamp(c.endMs)}\n${c.text}\n`).join("\n")}`;
}

export function formatSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.startMs)} --> ${srtTimestamp(c.endMs)}\n${c.text}\n`)
    .join("\n");
}

interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Legendas da montagem em ordem cena->take. Os offsets vêm dos clips
 * compilados (a mesma estrutura que OTIO e render consomem): cada palavra
 * cai na timeline pelo clip que a cobre, sem cursor float acumulado e sem
 * reordenar por tempo de fonte (o erro do buildSrt em multi-fonte).
 * Sem fala retida, devolve null — nunca lança (a exportação prossegue).
 */
export function buildSubtitles(project: Project): SubtitleResult | null {
  const fps = project.assembly.fps;
  if (!fps || !Number.isFinite(fps.num) || !Number.isFinite(fps.den) || fps.num <= 0 || fps.den <= 0) return null;
  // Trilha master: A1 cobre toda fonte com áudio (toda fala transcrita);
  // V1 é o fallback defensivo para montagens só com vídeo.
  const v1 = project.assembly.tracks.find((t) => t.name === "V1")?.clips ?? [];
  const a1 = project.assembly.tracks.find((t) => t.name === "A1")?.clips ?? [];
  const master = a1.length > 0 ? a1 : v1;
  if (master.length === 0) return null;
  const clipSeconds = (clip: Clip): number => (clip.durationFrames * fps.den) / fps.num;
  const clipEnd = (clip: Clip): number => clip.sourceStartSeconds + clipSeconds(clip);
  const timelineMs = (clip: Clip, t: number): number =>
    // Arredondamento único em ms no final: quadros (racionais exatos) +
    // deslocamento da palavra somados antes de arredondar, como em
    // compileScenes (toSeconds) — sem drift acumulado entre takes.
    Math.round(((clip.startFrame * fps.den) / fps.num + (t - clip.sourceStartSeconds)) * 1000);
  const locate = (sceneId: string, takeId: string, sourceId: string, t: number): Clip | undefined =>
    master.find((clip) => clip.sceneId === sceneId && clip.id.startsWith(`${sceneId}-${takeId}#`) && clip.sourceId === sourceId && t >= clip.sourceStartSeconds && t < clipEnd(clip))
      ?? master.find((clip) => clip.sceneId === sceneId && clip.sourceId === sourceId && t >= clip.sourceStartSeconds && t < clipEnd(clip))
      ?? master.find((clip) => clip.sourceId === sourceId && t >= clip.sourceStartSeconds && t < clipEnd(clip));
  const timelineEndMs = master.reduce(
    (end, clip) => Math.max(end, Math.round(((clip.startFrame + clip.durationFrames) * fps.den * 1000) / fps.num)), 0);

  const timed: TimedWord[] = [];
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      const retained = retainedRanges(take);
      if (retained.length === 0) continue;
      const analysis = project.analyses.find((item) => item.sourceId === take.sourceId);
      if (!analysis) continue;
      if (analysis.wordsStatus === "ready" && analysis.words.length > 0) {
        for (const word of effectiveWords(project, take.sourceId)) {
          const text = word.text.trim();
          if (!text) continue;
          if (word.end <= take.start || word.start >= take.end) continue;
          // Palavra fora dos ranges retidos (corte, cacoete) não legenda.
          if (subtractRanges([{ start: word.start, end: word.end }], retained).length > 0) continue;
          const clip = locate(scene.id, take.id, word.sourceId, word.start);
          if (!clip) continue;
          timed.push({ text, startMs: timelineMs(clip, word.start), endMs: timelineMs(clip, word.end) });
        }
      } else {
        // Fallback gracioso: spans de fala recortados aos ranges retidos.
        for (const range of retained) {
          for (const span of analysis.speech) {
            const start = Math.max(span.start, range.start);
            const end = Math.min(span.end, range.end);
            if (!(end > start) || !span.text.trim()) continue;
            const clip = locate(scene.id, take.id, span.sourceId, start);
            if (!clip) continue;
            timed.push({ text: span.text.trim(), startMs: timelineMs(clip, start), endMs: timelineMs(clip, end) });
          }
        }
      }
    }
  }
  if (timed.length === 0) return null;

  const cues: SubtitleCue[] = [];
  let current: TimedWord[] = [];
  let chars = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const startMs = Math.max(0, current[0]!.startMs);
    let endMs = Math.min(current[current.length - 1]!.endMs, timelineEndMs);
    if (!(endMs > startMs)) endMs = startMs + 1;
    cues.push({ startMs, endMs, text: current.map((w) => w.text).join(" ") });
    current = [];
    chars = 0;
  };
  for (const word of timed) {
    if (current.length > 0) {
      const prev = current[current.length - 1]!;
      if (word.startMs - prev.endMs > GAP_MS
        || prev.endMs - current[0]!.startMs > MAX_MS
        || chars + word.text.length + 1 > MAX_CHARS
        || SENTENCE_END.test(prev.text)) flush();
    }
    current.push(word);
    chars += word.text.length + 1;
  }
  flush();
  if (cues.length === 0) return null;
  return { cues, vtt: formatVtt(cues), srt: formatSrt(cues) };
}

/** Registro `legendas` do manifest da entrega: a ordem das chaves faz parte da comparação. */
export type SubtitleRecord =
  | { status: "pronto"; vttSha: string; srtSha: string }
  | { status: "indisponivel"; motivo: string };

/**
 * Legendas de uma revisão como a entrega as grava (best-effort): qualquer
 * falha, ou montagem sem fala retida, vira indisponibilidade e nunca lança.
 * A exportação e a rota de legendas da prévia passam por aqui, então as
 * duas dão o mesmo arquivo para a mesma revisão.
 */
export function subtitleRecord(project: Project): { legendas: SubtitleRecord; subtitles: SubtitleResult | null } {
  try {
    const subtitles = buildSubtitles(project);
    if (!subtitles) return { legendas: { status: "indisponivel", motivo: "sem falas retidas na montagem" }, subtitles: null };
    return {
      legendas: {
        status: "pronto",
        vttSha: createHash("sha256").update(subtitles.vtt, "utf8").digest("hex"),
        srtSha: createHash("sha256").update(subtitles.srt, "utf8").digest("hex"),
      },
      subtitles,
    };
  } catch (err) {
    return { legendas: { status: "indisponivel", motivo: err instanceof Error ? err.message : String(err) }, subtitles: null };
  }
}
