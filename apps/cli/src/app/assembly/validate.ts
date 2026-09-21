import type { Assembly, Clip, Rate, Source, Track } from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = new Set(["speech", "support", "both"]);
const KINDS = new Set(["Video", "Audio"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} precisa ser um número finito`);
  }
  return value;
}

function safeInt(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${label} precisa ser um inteiro seguro`);
  }
  return n;
}

function positiveInt(value: unknown, label: string): number {
  const n = safeInt(value, label);
  if (n <= 0) throw new Error(`${label} precisa ser um inteiro positivo`);
  return n;
}

function nonNegativeInt(value: unknown, label: string): number {
  const n = safeInt(value, label);
  if (n < 0) throw new Error(`${label} não pode ser negativo`);
  return n;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} precisa ser um texto não vazio`);
  }
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} precisa ser booleano`);
  return value;
}

function rate(value: unknown, label: string): Rate {
  if (!isRecord(value)) throw new Error(`${label} precisa ser um objeto`);
  return {
    num: positiveInt(value.num, `${label}.num`),
    den: positiveInt(value.den, `${label}.den`),
  };
}

function optionalRate(value: unknown, label: string): Rate | null {
  if (value === null) return null;
  return rate(value, label);
}

function optionalPositiveEven(value: unknown, label: string): number | null {
  if (value === null) return null;
  const n = positiveInt(value, label);
  if (n % 2 !== 0) throw new Error(`${label} precisa ser par`);
  return n;
}

function validateSource(value: unknown, index: number, seen: Set<string>): Source {
  if (!isRecord(value)) throw new Error(`fonte ${index} precisa ser um objeto`);
  const id = nonEmptyString(value.id, `fonte ${index}.id`);
  if (seen.has(id)) throw new Error(`id de fonte duplicado: ${id}`);
  seen.add(id);

  const sha256 = nonEmptyString(value.sha256, `fonte ${id}.sha256`);
  if (!SHA256.test(sha256)) {
    throw new Error(`fonte ${id}.sha256 precisa ter 64 caracteres hexadecimais`);
  }

  const role = nonEmptyString(value.role, `fonte ${id}.role`);
  if (!ROLES.has(role)) throw new Error(`fonte ${id}.role inválido`);

  const durationSeconds = finiteNumber(value.durationSeconds, `fonte ${id}.durationSeconds`);
  if (durationSeconds <= 0) {
    throw new Error(`fonte ${id}.durationSeconds precisa ser positiva`);
  }

  const source: Source = {
    id,
    path: nonEmptyString(value.path, `fonte ${id}.path`),
    sha256,
    durationSeconds,
    hasVideo: booleanField(value.hasVideo, `fonte ${id}.hasVideo`),
    hasAudio: booleanField(value.hasAudio, `fonte ${id}.hasAudio`),
    fps: optionalRate(value.fps, `fonte ${id}.fps`),
    width: optionalPositiveEven(value.width, `fonte ${id}.width`),
    height: optionalPositiveEven(value.height, `fonte ${id}.height`),
    role: role as Source["role"],
    included: value.included === undefined ? true : booleanField(value.included, `fonte ${id}.included`),
    name: nonEmptyString(value.name, `fonte ${id}.name`),
  };
  for (const key of ["size", "mtimeMs"] as const) {
    if (value[key] === undefined) continue;
    const n = finiteNumber(value[key], `fonte ${id}.${key}`);
    if (n < 0) throw new Error(`fonte ${id}.${key} não pode ser negativo`);
    source[key] = n;
  }
  if (value.timecode !== undefined && value.timecode !== null) {
    const tc = value.timecode;
    if (!isRecord(tc)) throw new Error(`fonte ${id}.timecode precisa ser um objeto`);
    source.timecode = {
      raw: nonEmptyString(tc.raw, `fonte ${id}.timecode.raw`),
      frames: tc.frames === null ? null : nonNegativeInt(tc.frames, `fonte ${id}.timecode.frames`),
      dropFrame: booleanField(tc.dropFrame, `fonte ${id}.timecode.dropFrame`),
    };
  } else if (value.timecode === null) {
    source.timecode = null;
  }
  if (value.rotation !== undefined && value.rotation !== null) {
    const deg = safeInt(value.rotation, `fonte ${id}.rotation`);
    if (![0, 90, 180, 270].includes(deg)) {
      throw new Error(`fonte ${id}.rotation precisa ser 0, 90, 180 ou 270`);
    }
    source.rotation = deg;
  } else if (value.rotation === null) {
    source.rotation = null;
  }
  return source;
}

function validateClip(value: unknown, index: number, trackName: string, seen: Set<string>): Clip {
  if (!isRecord(value)) {
    throw new Error(`clipe ${index} da pista ${trackName} precisa ser um objeto`);
  }
  const id = nonEmptyString(value.id, `clipe ${index}.id`);
  if (seen.has(id)) throw new Error(`id de clipe duplicado: ${id}`);
  seen.add(id);
  return {
    id,
    sceneId: nonEmptyString(value.sceneId, `clipe ${id}.sceneId`),
    sourceId: nonEmptyString(value.sourceId, `clipe ${id}.sourceId`),
    sourceStartSeconds: finiteNumber(value.sourceStartSeconds, `clipe ${id}.sourceStartSeconds`),
    startFrame: nonNegativeInt(value.startFrame, `clipe ${id}.startFrame`),
    durationFrames: positiveInt(value.durationFrames, `clipe ${id}.durationFrames`),
  };
}

function validateTrack(
  value: unknown,
  index: number,
  clipIds: Set<string>,
): Track {
  if (!isRecord(value)) throw new Error(`pista ${index} precisa ser um objeto`);
  const name = nonEmptyString(value.name, `pista ${index}.name`);
  const kind = nonEmptyString(value.kind, `pista ${name}.kind`);
  if (!KINDS.has(kind)) throw new Error(`pista ${name}.kind inválido`);
  if (!Array.isArray(value.clips)) {
    throw new Error(`pista ${name}.clips precisa ser um array`);
  }
  const clips = value.clips.map((clip, i) => validateClip(clip, i, name, clipIds));
  return { kind: kind as Track["kind"], name, clips };
}

function assertClipFits(clip: Clip, source: Source, assembly: Assembly): void {
  if (clip.sourceStartSeconds < 0) {
    throw new Error(`clipe ${clip.id} ultrapassa a fonte ${source.id}`);
  }
  const seconds = clip.durationFrames * assembly.fps.den / assembly.fps.num;
  if (clip.sourceStartSeconds + seconds > source.durationSeconds + 1e-9) {
    throw new Error(`clipe ${clip.id} ultrapassa a fonte ${source.id}`);
  }
}

function assertStream(clip: Clip, source: Source, kind: Track["kind"]): void {
  if (kind === "Video" && !source.hasVideo) {
    throw new Error(`clipe ${clip.id} pede vídeo da fonte ${source.id}, que não tem`);
  }
  if (kind === "Audio" && !source.hasAudio) {
    throw new Error(`clipe ${clip.id} pede áudio da fonte ${source.id}, que não tem`);
  }
}

function assertNoOverlap(track: Track): void {
  const ordered = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    if (next.startFrame < prev.startFrame + prev.durationFrames) {
      throw new Error(
        `sobreposição na pista ${track.name}: ${prev.id} e ${next.id}`,
      );
    }
  }
}

export function validateAssembly(value: unknown): Assembly {
  if (!isRecord(value)) throw new Error("montagem precisa ser um objeto");
  if (value.version !== 1) throw new Error("montagem.version precisa ser 1");
  if (!Array.isArray(value.sources)) throw new Error("montagem.sources precisa ser um array");
  if (!Array.isArray(value.tracks)) throw new Error("montagem.tracks precisa ser um array");

  const width = positiveInt(value.width, "montagem.width");
  const height = positiveInt(value.height, "montagem.height");
  if (width % 2 !== 0) throw new Error("montagem.width precisa ser par");
  if (height % 2 !== 0) throw new Error("montagem.height precisa ser par");

  const sourceIds = new Set<string>();
  const sources = value.sources.map((source, i) => validateSource(source, i, sourceIds));
  const byId = new Map(sources.map((source) => [source.id, source]));

  const clipIds = new Set<string>();
  const tracks = value.tracks.map((track, i) => validateTrack(track, i, clipIds));
  const fps = rate(value.fps, "montagem.fps");
  if (value.canvasSourceId !== undefined && value.canvasSourceId !== null) {
    nonEmptyString(value.canvasSourceId, "montagem.canvasSourceId");
  }
  const assembly: Assembly = {
    version: 1,
    revision: nonNegativeInt(value.revision, "montagem.revision"),
    name: nonEmptyString(value.name, "montagem.name"),
    fps,
    width,
    height,
    canvasSourceId: value.canvasSourceId as string | null | undefined,
    canvasManual: value.canvasManual === undefined
      ? undefined
      : booleanField(value.canvasManual, "montagem.canvasManual"),
    sources,
    tracks,
  };
  // Migração: projeto antigo com vídeo registra a fonte do formato sem
  // recalcular dimensões — o formato gravado segue até ação explícita.
  if (assembly.canvasSourceId === undefined) {
    const principal = sources.find((s) => s.role === "speech" && s.hasVideo)
      ?? sources.find((s) => s.hasVideo);
    if (principal) assembly.canvasSourceId = principal.id;
  }

  for (const track of tracks) {
    for (const clip of track.clips) {
      const source = byId.get(clip.sourceId);
      if (!source) {
        throw new Error(`clipe ${clip.id} referencia fonte ausente ${clip.sourceId}`);
      }
      assertStream(clip, source, track.kind);
      assertClipFits(clip, source, assembly);
    }
    assertNoOverlap(track);
  }

  return assembly;
}
