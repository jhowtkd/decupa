import { spawn } from "node:child_process";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CancelledError, isCancelledError } from "@decupa/queue";
import {
  base64Bytes,
  buildUnitsBlock,
  MAX_VIDEO_PAYLOAD_BYTES,
  readCache,
  writeCache,
  type DensityCandidate,
  type SpeechIndex,
  type StructureClaim,
  type TriageModel,
} from "@decupa/triage";

/** Teto de cada janela: ~10 min de vídeo com as unidades do trecho. */
export const WINDOW_MAX_SECONDS = 600;
/** Piso: abaixo disso o prompt repetido custa mais que o vídeo. */
const WINDOW_MIN_SECONDS = 60;
/** O encode de um trecho não sai exatamente proporcional ao todo. */
const WINDOW_SIZE_MARGIN = 0.8;
/** Folga em volta das unidades da janela: o vídeo começa um pouco antes da
 *  primeira fala e termina um pouco depois da última, e nada além disso. */
export const WINDOW_PAD_SECONDS = 1;
/** Quantas vezes uma janela que estourou o teto é repartida antes de recusar. */
export const WINDOW_MAX_REPLANS = 3;
/** Margem sobre a razão real (teto / tamanho recortado) ao repartir: o
 *  encode do trecho menor também não sai exatamente proporcional. */
const REPLAN_MARGIN = 0.85;
/** Teto de uma janela em bytes brutos (o teto de payload é em base64). */
const RAW_CAP_BYTES = MAX_VIDEO_PAYLOAD_BYTES * 3 / 4;

/** Trecho `[start, end)` do vídeo e as unidades que começam nele. */
export interface TriageWindow {
  index: number;
  start: number;
  end: number;
  unitIds: string[];
}

export type CutWindow = (
  src: string,
  dst: string,
  startSeconds: number,
  durationSeconds: number,
  signal?: AbortSignal,
) => Promise<void>;

/** Duração do vídeo pelo índice: a declarada, ou o fim da última unidade. */
function sourceDuration(index: SpeechIndex): number {
  const lastEnd = Math.max(...index.units.map((u) => u.end));
  return index.sourceDurationSeconds > 0 ? Math.max(index.sourceDurationSeconds, lastEnd) : lastEnd;
}

type WindowSpan = Omit<TriageWindow, "index">;

/**
 * Agrupa unidades contíguas em janelas de até `target` segundos de span. O
 * span conta o silêncio entre unidades do mesmo grupo (é vídeo enviado), então
 * uma pausa longa abre outra janela em vez de ser carregada. Uma unidade maior
 * que o alvo fica sozinha na janela dela. Cada janela vai da primeira à última
 * unidade, com `WINDOW_PAD_SECONDS` de folga, limitada a [0, duration].
 */
function packUnits(units: SpeechIndex["units"], target: number, duration: number): WindowSpan[] {
  const ordered = [...units].sort((a, b) => a.start - b.start);
  const windows: WindowSpan[] = [];
  let first = 0;
  let last = 0;
  let ids: string[] = [];
  const close = (): void => {
    windows.push({
      start: Math.max(0, first - WINDOW_PAD_SECONDS),
      end: Math.min(duration, last + WINDOW_PAD_SECONDS),
      unitIds: ids,
    });
  };
  for (const unit of ordered) {
    if (ids.length > 0 && Math.max(last, unit.end) - first > target) {
      close();
      ids = [];
    }
    if (ids.length === 0) {
      first = unit.start;
      last = unit.end;
    } else {
      last = Math.max(last, unit.end);
    }
    ids.push(unit.id);
  }
  if (ids.length > 0) close();
  return windows;
}

/**
 * Janelas só quando o vídeo inteiro passa do teto de payload; vídeo curto
 * continua numa chamada só (`null`). As janelas cobrem as UNIDADES, não o
 * silêncio (ver `packUnits`): o trecho calado entre janelas não é enviado, e é
 * ele que estourava o teto de payload numa gravação deixada rodando.
 *
 * O alvo de duração sai do bitrate MÉDIO do arquivo. Um trecho com bitrate
 * acima da média ainda pode passar do teto depois de recortado: quem recorta
 * (`prepareTriageWindows`) mede e reparte esse trecho.
 */
export function planTriageWindows(index: SpeechIndex, videoBytes: number): TriageWindow[] | null {
  if (base64Bytes(videoBytes) <= MAX_VIDEO_PAYLOAD_BYTES) return null;
  if (index.units.length === 0) return null;
  const duration = sourceDuration(index);
  const bytesPerSecond = videoBytes / Math.max(duration, 1);
  const fits = Math.floor(RAW_CAP_BYTES * WINDOW_SIZE_MARGIN / bytesPerSecond);
  const target = Math.max(WINDOW_MIN_SECONDS, Math.min(WINDOW_MAX_SECONDS, fits));
  return packUnits(index.units, target, duration).map((w, i) => ({ index: i, ...w }));
}

/**
 * Bloco de unidades da janela com os tempos contados do início do trecho,
 * porque o vídeo anexado é só o trecho.
 */
export function windowUnitsBlock(index: SpeechIndex, window: TriageWindow, total: number): string {
  const wanted = new Set(window.unitIds);
  const units = index.units
    .filter((u) => wanted.has(u.id))
    .map((u) => ({ ...u, start: u.start - window.start }));
  const header =
    `Trecho ${window.index + 1} de ${total} do vídeo, de ${window.start.toFixed(1)}s a ${window.end.toFixed(1)}s. ` +
    "O vídeo anexado é só este trecho, e os tempos abaixo contam a partir do início dele. " +
    "Julgue só as unidades listadas.";
  return `${header}\n\n${buildUnitsBlock({ ...index, units })}`;
}

/** Recorta e reencoda o trecho com os parâmetros do proxy de triagem. */
export const defaultCutWindow: CutWindow = async (src, dst, startSeconds, durationSeconds, signal) => {
  if (signal?.aborted) throw new CancelledError();
  const code = await new Promise<number>((resolve) => {
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-ss", startSeconds.toFixed(3), "-i", src, "-t", durationSeconds.toFixed(3),
      "-vf", "fps=1,scale='min(270,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
      "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "24k", "-ac", "1",
      "-y", dst,
    ], { signal });
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  // O ffmpeg morto pelo cancelar também sai com código != 0: não é falha do recorte.
  if (signal?.aborted) throw new CancelledError();
  if (code !== 0) throw new Error(`não consegui recortar o trecho da triagem em ${dst} (ffmpeg código ${code})`);
};

export interface PreparedWindow extends TriageWindow {
  videoPath: string;
  unitsBlock: string;
  /** Entra na chave de cache: cada trecho tem a sua resposta. */
  key: string;
}

/**
 * Gera (ou reusa) o vídeo de cada janela em `outDir/triage_windows`. O nome
 * leva o sha do vídeo leve, então trecho de outro vídeo nunca é reusado; e a
 * escrita é parcial + rename, como os proxies.
 *
 * Todas as janelas são recortadas e medidas ANTES da primeira chamada paga.
 * Uma janela de várias unidades que passa do teto (bitrate acima da média) é
 * repartida com um alvo menor, pela razão real teto/tamanho, até
 * `WINDOW_MAX_REPLANS` vezes; só as que estouraram são recortadas de novo.
 * Recusa, sem ter pago nada, quando uma unidade única não cabe ou quando as
 * tentativas acabam, cada caso com a causa certa.
 */
export async function prepareTriageWindows(opts: {
  index: SpeechIndex;
  videoPath: string;
  videoSha: string;
  outDir: string;
  cutWindow?: CutWindow;
  signal?: AbortSignal;
}): Promise<PreparedWindow[] | null> {
  const planned = planTriageWindows(opts.index, (await stat(opts.videoPath)).size);
  if (!planned) return null;
  const cut = opts.cutWindow ?? defaultCutWindow;
  const dir = join(opts.outDir, "triage_windows");
  await mkdir(dir, { recursive: true });
  const duration = sourceDuration(opts.index);
  const unitsById = new Map(opts.index.units.map((u) => [u.id, u] as const));

  interface Cut { span: WindowSpan; videoPath: string; bytes: number }
  const cutOne = async (span: WindowSpan): Promise<Cut> => {
    if (opts.signal?.aborted) throw new CancelledError();
    const key = `${span.start.toFixed(1)}-${span.end.toFixed(1)}`;
    const videoPath = join(dir, `${opts.videoSha.slice(0, 16)}-${key}.mp4`);
    if (!(await access(videoPath).then(() => true, () => false))) {
      const partial = join(dir, `${opts.videoSha.slice(0, 16)}-${key}.partial.mp4`);
      try {
        await cut(opts.videoPath, partial, span.start, span.end - span.start, opts.signal);
        await rename(partial, videoPath);
      } catch (error) {
        await rm(partial, { force: true });
        // Recorte morto pelo cancelar é cancelamento, seja qual for o erro que o recortador deu.
        if (opts.signal?.aborted && !isCancelledError(error)) throw new CancelledError();
        throw error;
      }
    }
    return { span, videoPath, bytes: (await stat(videoPath)).size };
  };
  const tooBig = (c: Cut): boolean => base64Bytes(c.bytes) > MAX_VIDEO_PAYLOAD_BYTES;

  let cuts: Cut[] = [];
  for (const window of planned) cuts.push(await cutOne({ start: window.start, end: window.end, unitIds: window.unitIds }));

  for (let attempt = 1; attempt <= WINDOW_MAX_REPLANS; attempt += 1) {
    if (!cuts.some((c) => tooBig(c) && c.span.unitIds.length > 1)) break;
    const next: Cut[] = [];
    for (const c of cuts) {
      if (!tooBig(c) || c.span.unitIds.length <= 1) {
        next.push(c);
        continue;
      }
      // O trecho encolhe na razão do que passou do teto, com margem.
      const target = (c.span.end - c.span.start) * (RAW_CAP_BYTES / c.bytes) * REPLAN_MARGIN;
      const units = c.span.unitIds.flatMap((id) => unitsById.get(id) ?? []);
      await rm(c.videoPath, { force: true });
      for (const span of packUnits(units, target, duration)) next.push(await cutOne(span));
    }
    cuts = next;
  }
  cuts.sort((a, b) => a.span.start - b.span.start);

  // Recusa ANTES da primeira chamada paga, com a causa certa.
  const megabytes = (c: Cut): string => (base64Bytes(c.bytes) / 1024 / 1024).toFixed(1);
  const teto = `${(MAX_VIDEO_PAYLOAD_BYTES / 1024 / 1024).toFixed(0)} MB`;
  const where = (c: Cut): string =>
    `a janela ${cuts.indexOf(c) + 1} de ${cuts.length} (${c.span.start.toFixed(1)}s a ${c.span.end.toFixed(1)}s) ` +
    `recortada tem ${megabytes(c)} MB em base64, acima do teto de ${teto} por chamada`;
  const stuck = cuts.find((c) => tooBig(c) && c.span.unitIds.length > 1);
  if (stuck) {
    throw new Error(
      `${where(stuck)}, mesmo depois de ${WINDOW_MAX_REPLANS} tentativas de dividi-la em trechos menores; ` +
      "nenhuma chamada foi feita. O bitrate desse trecho é alto demais para o teto: gere um proxy mais " +
      "leve ou divida o vídeo por fora.",
    );
  }
  const single = cuts.find(tooBig);
  if (single) {
    throw new Error(
      `${where(single)}; nenhuma chamada foi feita. ` +
      "Uma unidade de fala muito longa não cabe numa janela: divida o vídeo por fora.",
    );
  }

  return cuts.map((c, i) => {
    const window: TriageWindow = { index: i, ...c.span };
    return {
      ...window,
      videoPath: c.videoPath,
      unitsBlock: windowUnitsBlock(opts.index, window, cuts.length),
      key: `${c.span.start.toFixed(1)}-${c.span.end.toFixed(1)}`,
    };
  });
}

/**
 * O modelo visto pelos passes quando há janelas: estrutura e densidade viram
 * uma chamada por trecho, cada uma no cache com a chave do trecho (uma falha
 * no meio não cobra de novo os trechos que já responderam). Inspect não muda:
 * ele manda quadros, não o vídeo.
 */
export function windowedTriageModel(
  model: TriageModel,
  windows: PreparedWindow[],
  cache: { dir: string; keyOf: (pass: "structure" | "density", window: string, budgetSeconds?: number) => string },
): TriageModel {
  const cached = async <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    const hit = await readCache<T>(cache.dir, key);
    if (hit !== null) return hit;
    const value = await ask();
    await writeCache(cache.dir, key, value);
    return value;
  };
  const total = windows.reduce((sum, w) => sum + (w.end - w.start), 0) || 1;
  return {
    async structure() {
      const claims: StructureClaim[] = [];
      for (const w of windows) {
        claims.push(...await cached(cache.keyOf("structure", w.key), () =>
          model.structure({ unitsBlock: w.unitsBlock, videoPath: w.videoPath })));
      }
      return claims;
    },
    async density(req) {
      const merged: DensityCandidate[] = [];
      for (const w of windows) {
        // Orçamento proporcional à duração do trecho; o rank de cada trecho é
        // intercalado com o dos outros, porque os números não se comparam.
        const budgetSeconds = req.budgetSeconds * (w.end - w.start) / total;
        const part = await cached(cache.keyOf("density", w.key, budgetSeconds), () =>
          model.density({ unitsBlock: w.unitsBlock, videoPath: w.videoPath, budgetSeconds }));
        merged.push(...part.map((c) => ({
          ...c,
          rank: c.rank === Number.MAX_SAFE_INTEGER ? c.rank : (c.rank - 1) * windows.length + w.index + 1,
        })));
      }
      return merged;
    },
    inspect: (req) => model.inspect(req),
  };
}
