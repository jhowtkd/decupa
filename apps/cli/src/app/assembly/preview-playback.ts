import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashFile, probe, type MediaInfo } from "@decupa/media";
import { cacheConfigKey, emitCacheMetric, type CacheMetric } from "@decupa/bench";
import type { FileCoordinator } from "@decupa/coordinator";
import { createLimitedQueue } from "@decupa/queue";
import type { Executor } from "../pipeline.ts";
import { runHeavy } from "../heavy-work.ts";
import { mediaWork } from "./media-work.ts";

// A referência continua sendo o artefato aprovado/exportado. Este derivado
// pode ser apagado e refeito sem alterar a revisão ou a aprovação.
const PROFILE = "playback-v1";
const CONFIG_KEY = cacheConfigKey({ profile: PROFILE, video: "h264", audio: "aac", maxDimension: 960, crf: 26, maxrate: "1500k" });
const conversions = createLimitedQueue(1);

function validPlayback(info: MediaInfo, reference: MediaInfo): boolean {
  return info.hasVideo && info.videoCodec === "h264"
    && (!reference.hasAudio || (info.hasAudio && info.audioCodec === "aac"))
    && info.width !== null && info.height !== null
    && Math.max(info.width, info.height) <= 960
    && info.durationMs > 0 && Math.abs(info.durationMs - reference.durationMs) <= 100;
}

/** Cache por conteúdo, junto à revisão para acompanhar a retenção do projeto. */
export async function ensurePreviewPlayback(
  reference: string,
  exec: Executor,
  opts: { coordinator?: FileCoordinator; signal?: AbortSignal; cacheDir?: string; sha256?: string; onCacheMetric?: (metric: CacheMetric) => void } = {},
): Promise<string> {
  opts.signal?.throwIfAborted();
  const started = performance.now();
  let buildStarted = started, built = false;
  let outcome: CacheMetric["outcome"] = "error";
  // A rota já registra o hash no artefato; um Range não precisa reler a referência inteira.
  const sha = opts.sha256 && /^[a-f0-9]{64}$/.test(opts.sha256) ? opts.sha256 : await hashFile(reference);
  const cacheDir = opts.cacheDir ?? dirname(reference);
  const dest = join(cacheDir, `${PROFILE}-${sha}.mp4`);
  let original: MediaInfo;
  try {
    opts.signal?.throwIfAborted();
    original = await probe(reference);
    if (!original.hasVideo) { outcome = "not-applicable"; return reference; }
    const cached = await probe(dest).catch(() => null);
    opts.signal?.throwIfAborted();
    // Uma cópia já pronta não espera outra conversão na fila.
    if (cached && validPlayback(cached, original)) { outcome = "hit"; return dest; }
    const result = await conversions.run(build, { key: dest, signal: opts.signal });
    outcome = built ? "built" : "hit-or-shared";
    return result;
  } finally {
    emitCacheMetric(opts.onCacheMetric, { stage: "proxy", sha256: sha, configKey: CONFIG_KEY,
      outcome, durationMs: Math.max(0, performance.now() - (built ? buildStarted : started)) });
  }

  async function build(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    // Outra requisição/processo pode ter preenchido o cache durante a espera.
    const cached = await probe(dest).catch(() => null);
    if (cached && validPlayback(cached, original)) return dest;
    await mkdir(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `.${PROFILE}-${process.pid}-${randomBytes(6).toString("hex")}.tmp.mp4`);
    try {
      const result = await runHeavy(opts.coordinator, {
        stage: "rendering", signal,
        build: () => mediaWork.run(() => {
          built = true;
          buildStarted = performance.now();
          return exec.run({
            command: "ffmpeg",
            args: ["-v", "error", "-n", "-threads", "2", "-i", reference,
              "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1",
              "-vf", "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
              "-filter_threads", "1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
              "-maxrate", "1500k", "-bufsize", "3000k", "-threads", "2", "-pix_fmt", "yuv420p",
              "-force_key_frames", "expr:gte(t,n_forced*2)", "-c:a", "aac", "-b:a", "96k", "-ac", "2",
              "-movflags", "+faststart", tmp],
            signal,
          });
        }, signal ? { signal } : undefined),
      });
      signal?.throwIfAborted();
      if (result.code !== 0) {
        throw new Error(`falha ao preparar reprodução da prévia: ${result.stderr.trim().slice(-1000) || `código ${result.code}`}`);
      }
      const info = await probe(tmp);
      if (!validPlayback(info, original)) throw new Error("cópia de reprodução da prévia sem integridade");
      if (await hashFile(reference) !== sha) throw new Error("referência mudou durante o preparo da reprodução");
      signal?.throwIfAborted();
      await rename(tmp, dest);
      return dest;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
}
