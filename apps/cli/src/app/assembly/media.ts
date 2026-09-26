import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hashFile, probe } from "@decupa/media";
import type { Executor } from "../pipeline.ts";
import { detectHardwareProfile, encoderFor, type HardwareProfile } from "./hardware.ts";
import { mediaWork } from "./media-work.ts";
import type { Source } from "./types.ts";

export type MediaOpts = {
  signal?: AbortSignal;
  /** Perfil já comprovado: reutiliza o encoder sem redetectar hardware na fila. */
  profile?: HardwareProfile;
  /**
   * Sem `profile`, usa o perfil comprovado do projeto (mesma prova e mesmo
   * cache `hardware-proof/` do render da prévia). Desligado, o proxy segue
   * em software, como antes.
   */
  detectHardware?: boolean;
};

/** Bitrate do proxy de hardware: 960px de largura não precisa dos 8M do render. */
const PROXY_HW_BITRATE = "4M";

export function playbackDir(dir: string, sha256: string): string {
  return join(dir, "media", sha256);
}

export function proxyPath(dir: string, sha256: string): string {
  return join(playbackDir(dir, sha256), "proxy.mp4");
}

export function thumbnailPath(dir: string, sha256: string): string {
  return join(playbackDir(dir, sha256), "thumb.jpg");
}

/**
 * Confere que a fonte registrada continua a mesma: caminho rápido por
 * tamanho+mtime, caminho lento por hash quando as sentinelas faltam
 * (dados antigos) ou divergem. Troca no mesmo caminho nunca passa em
 * silêncio — pede reanálise ou relink.
 */
export async function verifySourceIdentity(source: Source): Promise<void> {
  let current: { size: number; mtimeMs: number };
  try {
    current = await stat(source.path);
  } catch {
    throw new Error(`mídia ausente: fonte ${source.id} em ${source.path}`);
  }
  if (
    source.size !== undefined && source.mtimeMs !== undefined
    && current.size === source.size && current.mtimeMs === source.mtimeMs
  ) {
    return;
  }
  const sha256 = await hashFile(source.path);
  if (sha256 !== source.sha256) {
    throw new Error(
      `conteúdo substituído na fonte ${source.id} (${source.path}): fonte ${source.id} foi substituída; reanálise ou relink necessário`,
    );
  }
}

async function proxyIsValid(path: string, source: Source): Promise<boolean> {
  try {
    const info = await probe(path);
    if (!info.hasVideo && !info.hasAudio) return false;
    const duration = info.durationMs / 1000;
    return Math.abs(duration - source.durationSeconds) <= Math.max(0.6, source.durationSeconds * 0.03);
  } catch {
    return false;
  }
}

/**
 * Proxy no perfil pedido; se o encode de hardware falhar ou sair inválido,
 * refaz em software — o proxy nunca fica indisponível por causa do hardware.
 */
async function buildProxy(
  source: Source,
  dir: string,
  exec: Executor,
  opts: MediaOpts = {},
): Promise<string> {
  const profile = opts.profile ?? "software";
  if (profile === "software") return buildProxyWith("software", source, dir, exec, opts);
  try {
    return await buildProxyWith(profile, source, dir, exec, opts);
  } catch (err) {
    opts.signal?.throwIfAborted();
    if (!(err instanceof ProxyError)) throw err;
    return buildProxyWith("software", source, dir, exec, opts);
  }
}

class ProxyError extends Error {}

async function buildProxyWith(
  profile: HardwareProfile,
  source: Source,
  dir: string,
  exec: Executor,
  opts: MediaOpts,
): Promise<string> {
  const outDir = playbackDir(dir, source.sha256);
  await mkdir(outDir, { recursive: true });
  const tmp = join(outDir, `proxy.${process.pid}.tmp.mp4`);
  const { encoder, hwaccel } = encoderFor(profile);
  const video = encoder === "libx264"
    ? ["-c:v", encoder]
    : ["-c:v", encoder, "-b:v", PROXY_HW_BITRATE, ...(encoder === "h264_videotoolbox" ? ["-allow_sw", "0"] : [])];
  const args = ["-n",
    ...(hwaccel ? ["-hwaccel", hwaccel] : []),
    "-threads", "2", "-i", source.path,
    "-map", "0:v:0?", "-map", "0:a:0?",
    "-vf", "scale='min(960,iw)':-2", "-filter_threads", "1",
    ...video, "-threads", "2",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", tmp];
  const result = await exec.run({ command: "ffmpeg", args, signal: opts.signal });
  if (result.code !== 0) {
    await unlink(tmp).catch(() => {});
    throw new ProxyError(
      `proxy falhou para a fonte ${source.id}: ${(result.stdout + result.stderr).trim().slice(0, 300) || "sem saída"}`,
    );
  }
  if (!(await proxyIsValid(tmp, source))) {
    await unlink(tmp).catch(() => {});
    throw new ProxyError(`proxy inválido para a fonte ${source.id}: stream ou duração incompatível`);
  }
  await rename(tmp, proxyPath(dir, source.sha256));
  return proxyPath(dir, source.sha256);
}

async function buildThumbnail(
  source: Source,
  dir: string,
  proxy: string,
  exec: Executor,
  opts: MediaOpts = {},
): Promise<string | null> {
  const outDir = playbackDir(dir, source.sha256);
  const tmp = join(outDir, `thumb.${process.pid}.tmp.jpg`);
  const at = Math.min(1, source.durationSeconds * 0.1);
  const result = await exec.run({
    command: "ffmpeg",
    args: ["-n", "-ss", String(at), "-i", proxy, "-vframes", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "5", tmp],
    signal: opts.signal,
  });
  if (result.code !== 0) {
    await unlink(tmp).catch(() => {});
    return null;
  }
  try {
    const { size } = await stat(tmp);
    if (size === 0) throw new Error("miniatura vazia");
  } catch {
    await unlink(tmp).catch(() => {});
    return null;
  }
  await rename(tmp, thumbnailPath(dir, source.sha256));
  return thumbnailPath(dir, source.sha256);
}

/** Miniatura independente do proxy; arquivos parciais nunca entram no cache. */
export async function ensureThumbnail(
  source: Source,
  dir: string,
  exec: Executor,
  opts: MediaOpts = {},
): Promise<string | null> {
  await verifySourceIdentity(source);
  if (!source.hasVideo) return null;
  opts.signal?.throwIfAborted();
  return mediaWork.run(async (signal) => {
    signal?.throwIfAborted();
    try {
      if ((await stat(thumbnailPath(dir, source.sha256))).size > 0) return thumbnailPath(dir, source.sha256);
    } catch {
      // Extração direta: uma miniatura não precisa transcodificar o vídeo inteiro.
    }
    await mkdir(playbackDir(dir, source.sha256), { recursive: true });
    return buildThumbnail(source, dir, source.path, exec, { ...opts, signal });
  }, { key: thumbnailPath(dir, source.sha256), signal: opts.signal });
}

/** Proxy H.264/AAC validado por probe; exportação continua usando o original. */
export async function ensurePlayback(
  source: Source,
  dir: string,
  exec: Executor,
  opts: MediaOpts = {},
): Promise<{ videoPath: string; thumbnailPath: string | null }> {
  await verifySourceIdentity(source);
  const proxy = proxyPath(dir, source.sha256);
  opts.signal?.throwIfAborted();
  // O perfil é resolvido FORA do slot: a prova de hardware também passa pela
  // mediaWork, que não é reentrante — detectar dentro do job travaria a fila.
  let profile = opts.profile;
  if (profile == null && opts.detectHardware && source.hasVideo && !(await proxyIsValid(proxy, source))) {
    profile = await detectHardwareProfile(source.path, join(dir, "hardware-proof"), exec, { signal: opts.signal });
  }
  // A miniatura aguarda o slot do proxy liberar: a fila não é reentrante.
  const videoPath = await mediaWork.run(async (signal) => {
    signal?.throwIfAborted();
    if (await proxyIsValid(proxy, source)) return proxy;
    return buildProxy(source, dir, exec, { ...opts, profile, signal });
  }, { key: proxy, signal: opts.signal });
  return { videoPath, thumbnailPath: await ensureThumbnail(source, dir, exec, opts) };
}
