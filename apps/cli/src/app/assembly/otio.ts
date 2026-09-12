import { pathToFileURL } from "node:url";
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

function externalReference(source: Source, assembly: Assembly, fps: number) {
  const width = source.width ?? assembly.width;
  const height = source.height ?? assembly.height;
  return {
    OTIO_SCHEMA: "ExternalReference.1",
    name: source.id,
    target_url: pathToFileURL(source.path).href,
    // Mesma rate do source_range do clipe: rates mistos no mesmo arquivo
    // (timeline vs fonte) deslocam in-point em importadores C++.
    available_range: range(0, mediaAvailableDuration(source, fps), fps),
    available_image_bounds: imageBounds(width, height),
    metadata: {
      decupa: {
        sourceId: source.id,
        width,
        height,
        fps: source.fps,
      },
    },
  };
}

function clipItem(clip: Clip, source: Source, assembly: Assembly, fps: number) {
  const startFrame = Math.round(clip.sourceStartSeconds * fps);
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

export function davinciImportSettings(assembly: Assembly) {
  const fps = fpsNumber(assembly);
  return {
    timelineFrameRate: String(fps),
    timelineResolutionWidth: String(assembly.width),
    timelineResolutionHeight: String(assembly.height),
    procedure: [
      "Criar projeto isolado (não alterar projetos existentes).",
      `Em Project Settings, definir Timeline format ${assembly.width}×${assembly.height} e frame rate ${assembly.fps.num}/${assembly.fps.den} (${fps}).`,
      "File → Import → Timeline no OTIO desta revisão.",
      "Se Automatically set project settings ainda aplicar 24 fps ou 1920×1080, desligar essa opção e manter os valores acima.",
      "scriptapp(Resolve) pode devolver None neste Mac — a prova é pela UI: pistas, mídias online, fps e canvas.",
    ],
  };
}

export function buildOtio(assembly: Assembly): string {
  const valid = validateAssembly(assembly);
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
    global_start_time: time(fps * 3600, fps),
    metadata: {
      decupa: {
        width: valid.width,
        height: valid.height,
        fps: valid.fps,
        revision: valid.revision,
      },
      Resolve: {
        timelineFrameRate: String(fps),
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
