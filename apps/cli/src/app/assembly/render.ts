import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArtifact, publishAtomic } from "@decupa/cache";
import { hashFile, probe } from "@decupa/media";
import type { Executor } from "../pipeline.ts";
import { verifySourceIdentity } from "./media.ts";
import { mediaWork } from "./media-work.ts";
import { pruneProject } from "./retention.ts";
import type { Assembly, Source, Track } from "./types.ts";
import { validateAssembly } from "./validate.ts";
import { encoderFor, detectHardwareProfile, type HardwareProfile } from "./hardware.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const RENDER_SCRIPT = join(REPO_ROOT, "scripts", "render-assembly.py");

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} precisa ser um caminho absoluto: ${path}`);
  }
  return path;
}

function clipReason(source: Source, track: Track): string {
  if (track.kind === "Audio") return "speech";
  if (source.role === "support") return "support";
  return "speech";
}

function engineAsset(source: Source) {
  const path = absolutePath(source.path, `fonte ${source.id}`);
  return {
    id: source.id,
    path,
    uri: path,
    name: basename(path),
    role: source.role,
    has_video: source.hasVideo,
    has_audio: source.hasAudio,
  };
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

function engineClip(
  clip: Assembly["tracks"][number]["clips"][number],
  source: Source,
  track: Track,
  fps: number,
) {
  const path = absolutePath(source.path, `fonte ${source.id}`);
  const reason = clipReason(source, track);
  const muted = track.kind !== "Audio";
  const durationSeconds = framesToSeconds(clip.durationFrames, fps);
  return {
    id: clip.id,
    source: path,
    path,
    asset_id: source.id,
    start: clip.sourceStartSeconds,
    end: clip.sourceStartSeconds + durationSeconds,
    in_point: clip.sourceStartSeconds,
    out_point: clip.sourceStartSeconds + durationSeconds,
    timeline_start: framesToSeconds(clip.startFrame, fps),
    volume: muted ? 0 : 1,
    muted,
    speed: 1,
    reason,
  };
}

export function toEngineTimeline(a: Assembly): object {
  const valid = validateAssembly(a);
  const fps = valid.fps.num / valid.fps.den;
  const sources = new Map(valid.sources.map((source) => [source.id, source]));
  const assets = valid.sources.map(engineAsset);
  const tracks = valid.tracks.map((track, index) => ({
    type: track.kind === "Video" ? "video" : "audio",
    name: track.name,
    order: index + 1,
    clips: track.clips.map((clip) => {
      const source = sources.get(clip.sourceId);
      if (!source) {
        throw new Error(`clipe ${clip.id} referencia fonte ausente ${clip.sourceId}`);
      }
      return engineClip(clip, source, track, fps);
    }),
  }));
  const output_canvas = {
    width: valid.width,
    height: valid.height,
    fps,
  };
  const project = {
    name: valid.name,
    revision: valid.revision,
    width: valid.width,
    height: valid.height,
    fps: output_canvas.fps,
    assets,
    tracks,
    output_canvas,
    sequence: output_canvas,
  };
  return { project, assets, tracks, output_canvas, sequence: output_canvas };
}

const RENDERER_VERSION = 2;

export function previewIdentity(assembly: Assembly, profile: HardwareProfile = "software"): string {
  const valid = validateAssembly(assembly);
  return createHash("sha256")
    .update(JSON.stringify({
      fps: valid.fps,
      width: valid.width,
      height: valid.height,
      sources: valid.sources.map((source) => ({
        id: source.id,
        sha256: source.sha256,
        included: source.included,
      })),
      tracks: valid.tracks,
      profile,
      rendererVersion: RENDERER_VERSION,
    }))
    .digest("hex");
}

/**
 * Lê o relatório do motor na saída do adaptador. Quando o hardware falha e o
 * motor repete em software, o fallback nunca é escondido: o cache passa a ser
 * identificado como software. Saída sem JSON (fakes, versões antigas) mantém
 * o perfil pedido.
 */
export function motorFellBack(stdout: string): boolean {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { data?: { fallback?: unknown } };
      if (parsed?.data?.fallback === true) return true;
    } catch {
      // Linha JSON parcial ou de outro emissor: ignora e segue.
    }
  }
  return false;
}

type PreviewRecord = { sha256: string; profile: HardwareProfile };

// Renders concorrentes do mesmo conteúdo se serializam: cada pedido roda
// o seu (pastas de trabalho distintas), mas nunca ao mesmo tempo — os
// arquivos do preview-cache e do rev-<n> são compartilhados e o rename
// concorrente falha no Windows (EPERM).
const renderTurns = new Map<string, Promise<unknown>>();

export async function renderAssembly(
  a: Assembly,
  outDir: string,
  exec: Executor,
  opts: { profile?: HardwareProfile; detectHardware?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const key = `${outDir}${previewIdentity(validateAssembly(a), opts.profile ?? "software")}`;
  const previous = renderTurns.get(key) ?? Promise.resolve();
  const turn = previous.then(
    () => renderAssemblyOnce(a, outDir, exec, opts),
    () => renderAssemblyOnce(a, outDir, exec, opts),
  );
  const tracked = turn.catch(() => undefined);
  renderTurns.set(key, tracked);
  try {
    return await turn;
  } finally {
    if (renderTurns.get(key) === tracked) renderTurns.delete(key);
  }
}

async function renderAssemblyOnce(
  a: Assembly,
  outDir: string,
  exec: Executor,
  opts: { profile?: HardwareProfile; detectHardware?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const valid = validateAssembly(a);
  for (const source of valid.sources) {
    absolutePath(source.path, `fonte ${source.id}`);
    await verifySourceIdentity(source);
  }
  let profile = opts.profile ?? "software";
  if (opts.detectHardware && opts.profile == null) {
    const source = valid.sources.find((item) => item.hasVideo) ?? valid.sources[0];
    if (source) {
      profile = await detectHardwareProfile(source.path, join(outDir, "hardware-proof"), exec, {
        signal: opts.signal,
      });
    }
  }
  const requestKey = previewIdentity(valid, profile);
  const requestCacheDir = join(outDir, "preview-cache", requestKey);
  const requestCachedMp4 = join(requestCacheDir, "reference.mp4");
  const requestSidecar = join(requestCacheDir, "preview.json");
  const dest = join(outDir, `rev-${valid.revision}`, "reference.mp4");
  const cached = await inspectArtifact(requestSidecar);
  if (cached.status === "ready") {
    const info = await probe(requestCachedMp4).catch(() => null);
    if (info && (info.hasVideo || info.hasAudio) && info.durationMs > 0) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(requestCachedMp4, dest);
      return dest;
    }
  }
  const published = join(outDir, `rev-${valid.revision}`);
  const work = join(
    published,
    `.work-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(work, { recursive: true });
  const timelinePath = join(work, "timeline.json");
  const outPath = join(work, "reference.mp4");
  await writeFile(timelinePath, `${JSON.stringify(toEngineTimeline(valid), null, 2)}\n`, "utf8");

  try {
    const { encoder, hwaccel } = encoderFor(profile);
    // Só o exec pesado entra na fila (sem chave: cada chamada roda a sua);
    // a detecção acima já liberou o slot. Cancelamento verificado ao sair.
    const result = await mediaWork.run(async () => {
      opts.signal?.throwIfAborted();
      return exec.run({
        command: "python3",
        args: [
          RENDER_SCRIPT,
          "--timeline", timelinePath,
          "--out", outPath,
          "--work", work,
          "--encoder", encoder,
          ...(hwaccel ? ["--hwaccel", hwaccel] : []),
        ],
        cwd: work,
        env: { CLAUDE_PROJECT_DIR: work },
        signal: opts.signal,
      });
    }, opts.signal ? { signal: opts.signal } : undefined);
    if (result.code !== 0) {
      const detail = (result.stdout + result.stderr).trim().slice(0, 1500);
      throw new Error(`render falhou (código ${result.code}): ${detail || "sem saída"}`);
    }

    const exists = await access(outPath).then(() => true, () => false);
    if (!exists) {
      throw new Error(`render concluiu sem o mp4 de saída em ${outPath}`);
    }
    const tmp = join(
      published,
      `.reference-${process.pid}-${randomBytes(4).toString("hex")}.tmp.mp4`,
    );
    await rename(outPath, tmp);
    // Valida o arquivo exclusivo do job ANTES de publicar: um render
    // inválido nunca substitui a referência válida anterior.
    try {
      const info = await probe(tmp).catch((err: unknown) => {
        throw new Error(`prévia sem integridade: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (!info.hasVideo && !info.hasAudio) {
        throw new Error("prévia sem streams de vídeo nem áudio");
      }
      if (info.durationMs <= 0) {
        throw new Error("prévia com duração zerada");
      }
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await rename(tmp, dest);
    // Fallback explícito do motor: o cache é identificado como software,
    // nunca como o perfil de hardware pedido.
    const effectiveProfile = motorFellBack(result.stdout) ? "software" : profile;
    const cacheDir = join(outDir, "preview-cache", previewIdentity(valid, effectiveProfile));
    const cachedMp4 = join(cacheDir, "reference.mp4");
    const sidecar = join(cacheDir, "preview.json");
    await mkdir(cacheDir, { recursive: true });
    await copyFile(dest, cachedMp4);
    await publishAtomic(sidecar, `${JSON.stringify({
      sha256: await hashFile(dest),
      profile: effectiveProfile,
    } satisfies PreviewRecord)}\n`);
    // Poda best-effort de derivados antigos (retention.ts): nunca falha o
    // render — erro é silenciosamente ignorado (retorno descartado).
    await pruneProject(outDir).catch(() => {});
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
