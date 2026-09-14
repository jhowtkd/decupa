import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAnalysisClient, readCredentials, ZAI_DEFAULT_MODEL } from "@decupa/triage";
import type { Executor } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import type { Source, VisualSpan } from "./types.ts";
import { analysisCacheDir } from "./analysis.ts";
import { mergeAdjacent, validateVisual, visualWindows } from "./visual.ts";
import { extractVisualFrames } from "./frames.ts";
import type { VisualFrame, VisualWindow } from "./frames.ts";

export const VISUAL_PROMPT = `Você recebe frames JPEG timestampados (amostrados a 1 fps), não um vídeo contínuo.
Cada frame é rotulado como FRAME fonte=0s local=0s: fonte é o segundo absoluto da fonte e local é o segundo deste trecho.
Descreva o que é observável por segundo: ações, objetos, enquadramento e incerteza.
Não identifique pessoas por nome sem essa informação no pedido.
Responda só sobre a mídia recebida, em JSON:

{"spans":[{"id":"local-0","start":0,"end":1,"text":"descrição","confidence":"observed","tags":["objeto"]}]}

start/end são segundos locais deste trecho (origem 0). confidence é observed, uncertain ou unavailable.
Não invente o que não aparece. Se um segundo não for observável, confidence unavailable.`;

/** Versão do prompt (invalida o cache) e do envelope de cache em disco. */
export const VISUAL_PROMPT_VERSION = 2;
export const VISUAL_CACHE_VERSION = "visual-v3-frames";

export type DescribeDeps = {
  client: { send(content: unknown[], signal?: AbortSignal): Promise<string> };
  exec?: Executor;
};

type VisualWindowCache = {
  version: string;
  sha256: string;
  promptVersion: number;
  model: string;
  inputMode: string;
  sampleFps: number;
  window: VisualWindow;
  spans: VisualSpan[];
};

function cacheFile(cacheDir: string, window: VisualWindow): string {
  return join(cacheDir, `w-${window.start}-${window.end}.json`);
}

function parseWindowCache(raw: unknown, source: Source, window: VisualWindow): VisualSpan[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const cache = raw as Partial<VisualWindowCache>;
  if (cache.version !== VISUAL_CACHE_VERSION) return null;
  if (cache.sha256 !== source.sha256) return null;
  if (cache.promptVersion !== VISUAL_PROMPT_VERSION) return null;
  if (cache.model !== ZAI_DEFAULT_MODEL) return null;
  // Envelope antigo (vídeo mp4 ou outro fps) não vale como cache de frames.
  if (cache.inputMode !== "frames" || cache.sampleFps !== 1) return null;
  const bounds = cache.window;
  if (!bounds || bounds.start !== window.start || bounds.end !== window.end
    || bounds.fetchStart !== window.fetchStart) {
    return null;
  }
  if (!Array.isArray(cache.spans)) return null;
  // Mesmo hash sob outra fonte (relink): remapeia IDs como adaptAnalysis.
  const prefix = `${(cache.spans[0] as VisualSpan | undefined)?.sourceId ?? ""}:`;
  const remapped = (cache.spans as VisualSpan[]).map((span) => {
    if (span.sourceId === source.id) return span;
    const suffix = span.id.startsWith(prefix) ? span.id.slice(prefix.length) : span.id;
    return { ...span, id: `${source.id}:${suffix}`, sourceId: source.id };
  });
  return validateVisual(remapped, source);
}

/**
 * Monta a mensagem visual: prompt + rótulos por frame. Cada JPEG vem
 * etiquetado com o segundo da fonte e o local da janela, para que o
 * modelo responda em segundos locais sem somar a origem duas vezes.
 */
function frameMessage(frames: VisualFrame[], window: VisualWindow): unknown[] {
  return [
    {
      type: "text",
      text: VISUAL_PROMPT + "\n\n" +
        "intervalo solicitado na fonte: [" + window.start + ", " + window.end + ")\n" +
        "cada imagem abaixo está rotulada pelo segundo da fonte; " +
        "responda usando segundos locais da janela, de 0 a " +
        (window.end - window.fetchStart) + ".",
    },
    ...frames.flatMap((frame) => [
      {
        type: "text",
        text: "FRAME fonte=" + frame.sourceSecond +
          "s local=" + (frame.sourceSecond - window.fetchStart) + "s",
      },
      { type: "image_url", image_url: { url: frame.dataUrl } },
    ]),
  ];
}

/**
 * Janela concluída: cada segundo de [start, end) tem alguma evidência
 * (inclusive `unavailable` explícito). Cache parcial nunca vale como
 * janela concluída — a retomada solicita a janela de novo e conserva
 * o que já estava válido.
 */
const INTERVAL_EPS = 1e-9;

/**
 * O trecho novo substitui o anterior quando o redescreve por inteiro
 * (mesmo intervalo ou superconjunto). Posição na resposta nunca decide
 * substituição — só o intervalo efetivamente descrito.
 */
function coversInterval(fresh: VisualSpan, prev: VisualSpan): boolean {
  return fresh.start <= prev.start + INTERVAL_EPS && prev.end <= fresh.end + INTERVAL_EPS;
}

function uniqueSpanId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}~${n}`)) n += 1;
  return `${base}~${n}`;
}

function windowCovered(spans: VisualSpan[], window: VisualWindow): boolean {
  const clipped = spans
    .map((span) => ({ start: Math.max(span.start, window.start), end: Math.min(span.end, window.end) }))
    .filter((range) => range.start < range.end);
  for (let start = window.start; start < window.end; start += 1) {
    const end = Math.min(start + 1, window.end);
    if (!clipped.some((range) => range.start < end && start < range.end)) return false;
  }
  return true;
}

function parseLocalSpans(text: string, source: Source, window: VisualWindow): VisualSpan[] {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const payload = JSON.parse(unfenced) as { spans?: unknown };
  const rawSpans = Array.isArray(payload.spans) ? payload.spans : [];
  // Spans são inferidos de frames timestampados: valida os limites locais
  // ANTES de somar fetchStart — uma única soma.
  const local = validateVisual(
    rawSpans.map((span) => {
      const rec = (span && typeof span === "object") ? span as Record<string, unknown> : {};
      return { ...rec, sourceId: source.id };
    }),
    { ...source, durationSeconds: window.end - window.fetchStart },
  );
  const shifted = local
    .map((span) => ({
      ...span,
      start: span.start + window.fetchStart,
      end: span.end + window.fetchStart,
    }))
    .map((span) => ({
      ...span,
      start: Math.max(span.start, window.start),
      end: Math.min(span.end, window.end),
    }))
    .filter((span) => span.end > span.start)
    .map((span, i) => ({ ...span, id: `${source.id}:w${window.start}:${i}` }));
  return validateVisual(shifted, source);
}

export async function describeSource(
  source: Source,
  dir: string,
  signal: AbortSignal,
  deps?: DescribeDeps,
): Promise<VisualSpan[]> {
  if (!source.hasVideo) return [];
  if (source.durationSeconds <= 0) throw new Error(`fonte ${source.id} sem duração para descrever`);
  const stored = await readCredentials(dir).catch(() => null);
  const client = deps?.client ?? createAnalysisClient({ stored });
  const exec = deps?.exec ?? new SpawnExecutor();
  const cacheDir = join(analysisCacheDir(dir, source.sha256), VISUAL_CACHE_VERSION);
  await mkdir(cacheDir, { recursive: true });

  const collected: VisualSpan[] = [];
  for (const window of visualWindows(source.durationSeconds)) {
    if (signal.aborted) throw new Error("descrição visual cancelada");
    const file = cacheFile(cacheDir, window);
    let previous: VisualSpan[] = [];
    try {
      const cached = parseWindowCache(JSON.parse(await readFile(file, "utf8")), source, window);
      if (cached && windowCovered(cached, window)) {
        collected.push(...cached);
        continue;
      }
      // Janela incompleta: solicita de novo e conserva o válido abaixo.
      previous = cached ?? [];
    } catch {
      // cache miss ou inválido: processa a janela
    }
    try {
      const frames = await extractVisualFrames(source, window, cacheDir, exec);
      if (signal.aborted) throw new Error("descrição visual cancelada");
      const text = await client.send(frameMessage(frames, window), signal);
      const fresh = parseLocalSpans(text, source, window);
      // Une sem perda: o novo substitui só o anterior que ele redescreve
      // por inteiro; intervalos complementares são conservados. Ids
      // posicionais podem repetir entre respostas — colisão com intervalo
      // distinto ganha sufixo único em vez de apagar o trecho antigo.
      const kept = previous.filter((prev) => !fresh.some((f) => coversInterval(f, prev)));
      const taken = new Set(kept.map((span) => span.id));
      const placed = fresh.map((span) => {
        const id = uniqueSpanId(span.id, taken);
        taken.add(id);
        return id === span.id ? span : { ...span, id };
      });
      const merged = mergeAdjacent([...kept, ...placed]);
      const envelope: VisualWindowCache = {
        version: VISUAL_CACHE_VERSION,
        sha256: source.sha256,
        promptVersion: VISUAL_PROMPT_VERSION,
        model: ZAI_DEFAULT_MODEL,
        inputMode: "frames",
        sampleFps: 1,
        window,
        spans: merged,
      };
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(envelope)}\n`, "utf8");
      await rename(tmp, file);
      collected.push(...merged);
    } catch (err) {
      // Cancelamento propaga como erro: lista parcial não é sucesso.
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  return mergeAdjacent(collected);
}
