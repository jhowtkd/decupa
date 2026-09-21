import { pathToFileURL } from "node:url";
import { sourceMediaStartSeconds } from "./timecode.ts";
import type { Assembly, Clip, Source, Track } from "./types.ts";
import { validateAssembly } from "./validate.ts";

const time = (value: number, rate: number) =>
  ({ OTIO_SCHEMA: "RationalTime.1" as const, value, rate });

const range = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: "TimeRange.1" as const,
  start_time: time(start, rate),
  duration: time(duration, rate),
});

function fpsNumber(assembly: Assembly): number {
  return assembly.fps.num / assembly.fps.den;
}

// Rótulo curto e estável para metadata do Resolve (ex.: "29.97", "25").
// A matemática de frames continua usando o float exato num/den.
function fpsLabel(fps: number): string {
  return String(Math.round(fps * 100) / 100);
}

function imageBounds(width: number, height: number) {
  return {
    OTIO_SCHEMA: "Box2d.1",
    min: { OTIO_SCHEMA: "V2d.1", x: 0, y: 0 },
    max: { OTIO_SCHEMA: "V2d.1", x: width, y: height },
  };
}

function mediaAvailableDuration(source: Source, fps: number): number {
  return Math.round(source.durationSeconds * fps);
}

/**
 * Recusa fontes com etiqueta de timecode que não converte: exportar com
 * origem assumida em 0 deslocaria os in-points silenciosamente.
 */
export function assertTimecodesReadable(assembly: Assembly): void {
  for (const source of assembly.sources) {
    if (source.timecode && source.timecode.frames == null) {
      throw new Error(
        `fonte ${source.id} ("${source.name}") tem timecode ilegível "${source.timecode.raw}" — ` +
        "corrija a etiqueta na mídia (ex.: ffmpeg -timecode) ou grave a mídia sem timecode",
      );
    }
  }
}

/**
 * Início da mídia em frames da taxa da timeline: o timecode embutido da
 * fonte (convertido preservando segundos) ou 0 para mídia sem etiqueta.
 */
function sourceMediaStart(source: Source, fps: number): number {
  const seconds = sourceMediaStartSeconds(source);
  return seconds == null ? 0 : Math.round(seconds * fps);
}

function externalReference(source: Source, assembly: Assembly, fps: number) {
  const width = source.width ?? assembly.width;
  const height = source.height ?? assembly.height;
  // available_range começa no timecode da mídia (mesma rate do clip —
  // a conversão preserva segundos, então o in-point cai no frame certo).
  const mediaStart = sourceMediaStart(source, fps);
  return {
    OTIO_SCHEMA: "ExternalReference.1",
    name: source.id,
    target_url: pathToFileURL(source.path).href,
    // Mesma rate do source_range do clipe: rates mistos no mesmo arquivo
    // (timeline vs fonte) deslocam in-point em importadores C++.
    available_range: range(mediaStart, mediaAvailableDuration(source, fps), fps),
    available_image_bounds: imageBounds(width, height),
    metadata: {
      decupa: {
        sourceId: source.id,
        width,
        height,
        fps: source.fps,
        timecode: source.timecode?.raw ?? null,
        rotation: source.rotation ?? 0,
      },
    },
  };
}

function clipItem(clip: Clip, source: Source, assembly: Assembly, fps: number) {
  // In-point = início da mídia (timecode) + offset do corte, na mesma rate:
  // a distância entre cortes de um mesmo clipe fica preservada exata.
  const startFrame = sourceMediaStart(source, fps) + Math.round(clip.sourceStartSeconds * fps);
  return {
    OTIO_SCHEMA: "Clip.1",
    name: clip.id,
    source_range: {
      OTIO_SCHEMA: "TimeRange.1",
      start_time: time(startFrame, fps),
      duration: time(clip.durationFrames, fps),
    },
    media_reference: externalReference(source, assembly, fps),
  };
}

function gapItem(durationFrames: number, fps: number) {
  return {
    OTIO_SCHEMA: "Gap.1",
    name: "gap",
    source_range: range(0, durationFrames, fps),
  };
}

function trackChildren(
  track: Track,
  sources: Map<string, Source>,
  assembly: Assembly,
  fps: number,
) {
  const ordered = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
  const children: object[] = [];
  let cursor = 0;
  for (const clip of ordered) {
    const source = sources.get(clip.sourceId);
    if (!source) {
      throw new Error(`clipe ${clip.id} referencia fonte ausente ${clip.sourceId}`);
    }
    if (clip.startFrame > cursor) {
      children.push(gapItem(clip.startFrame - cursor, fps));
    }
    children.push(clipItem(clip, source, assembly, fps));
    cursor = clip.startFrame + clip.durationFrames;
  }
  return children;
}

export function timelineDurationFrames(assembly: Assembly): number {
  let end = 0;
  for (const track of assembly.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.startFrame + clip.durationFrames);
    }
  }
  return end;
}

/** Orientação de exibição do canvas: dimensões já vêm giradas quando a fonte rotacionada define o formato. */
export function orientationOf(assembly: { width: number; height: number }): "horizontal" | "vertical" | "quadrado" {
  return assembly.width > assembly.height ? "horizontal" : assembly.width < assembly.height ? "vertical" : "quadrado";
}

/**
 * Linhas por fonte para a conferência manual: identidade, taxa real,
 * timecode e rotação esperados na mídia importada.
 */
export function sourceChecklist(assembly: Assembly): string[] {
  return assembly.sources.map((source) => {
    const fps = source.fps ? `${source.fps.num}/${source.fps.den}` : "taxa da timeline";
    const tc = source.timecode
      ? `timecode ${source.timecode.raw}${source.timecode.dropFrame ? " (drop-frame)" : ""}`
      : "sem timecode — início em 00:00:00:00";
    const rot = source.rotation ? `rotação ${source.rotation}°` : "sem rotação";
    return `- ${source.id} "${source.name}": ${fps} fps, ${tc}, ${rot}`;
  });
}

export function davinciImportSettings(assembly: Assembly) {
  const fps = fpsNumber(assembly);
  return {
    timelineFrameRate: fpsLabel(fps),
    timelineResolutionWidth: String(assembly.width),
    timelineResolutionHeight: String(assembly.height),
    orientation: orientationOf(assembly),
    procedure: [
      "Criar projeto isolado (não alterar projetos existentes).",
      `Em Project Settings, definir Timeline format ${assembly.width}×${assembly.height} (${orientationOf(assembly)}) e frame rate ${assembly.fps.num}/${assembly.fps.den} (${fps}).`,
      "File → Import → Timeline no OTIO desta revisão.",
      "Conferir cada mídia importada: abre o arquivo original e respeita o timecode embutido (in-points batem com a referência).",
      "Se Automatically set project settings ainda aplicar 24 fps ou 1920×1080, desligar essa opção e manter os valores acima.",
      "scriptapp(Resolve) pode devolver None neste Mac — a prova é pela UI: pistas, mídias online, fps e canvas.",
    ],
    sources: sourceChecklist(assembly),
  };
}

export function buildOtio(assembly: Assembly): string {
  const valid = validateAssembly(assembly);
  assertTimecodesReadable(valid);
  const fps = fpsNumber(valid);
  const durationFrames = timelineDurationFrames(valid);
  const sources = new Map(valid.sources.map((source) => [source.id, source]));
  const tracks = valid.tracks.map((track) => ({
    OTIO_SCHEMA: "Track.1",
    name: track.name,
    kind: track.kind,
    children: trackChildren(track, sources, valid, fps),
  }));
  return JSON.stringify({
    OTIO_SCHEMA: "Timeline.1",
    name: valid.name,
    global_start_time: time(Math.round(fps * 3600), fps),
    metadata: {
      decupa: {
        width: valid.width,
        height: valid.height,
        fps: valid.fps,
        revision: valid.revision,
      },
      Resolve: {
        timelineFrameRate: fpsLabel(fps),
        timelineResolutionWidth: String(valid.width),
        timelineResolutionHeight: String(valid.height),
      },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: range(0, durationFrames, fps),
      children: tracks,
    },
  });
}
