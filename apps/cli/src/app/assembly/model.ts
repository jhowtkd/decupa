import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZaiClient } from "@decupa/triage";
import type { Executor } from "../pipeline.ts";
import { SpawnExecutor } from "../pipeline.ts";
import type { Source, VisualSpan } from "./types.ts";
import { analysisCacheDir } from "./analysis.ts";
import { mergeAdjacent, validateVisual, visualWindows } from "./visual.ts";

export const VISUAL_PROMPT = `Você recebe um trecho de vídeo (proxy, 1 fps, proporção preservada).
Descreva o que é observável por segundo: ações, objetos, enquadramento e incerteza.
Não identifique pessoas por nome sem essa informação no pedido.
Responda só sobre a mídia recebida, em JSON:

{"spans":[{"id":"local-0","start":0,"end":1,"text":"descrição","confidence":"observed","tags":["objeto"]}]}

start/end são segundos locais deste trecho (origem 0). confidence é observed, uncertain ou unavailable.
Não invente o que não aparece. Se um segundo não for observável, confidence unavailable.`;

export type DescribeDeps = {
  client: { send(content: unknown[], signal?: AbortSignal): Promise<string> };
  exec?: Executor;
};

function parseSpans(text: string, source: Source): VisualSpan[] {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const payload = JSON.parse(unfenced) as { spans?: unknown };
  const rawSpans = Array.isArray(payload.spans) ? payload.spans : [];
  const unbounded = { ...source, durationSeconds: Number.MAX_SAFE_INTEGER };
  return validateVisual(
    rawSpans.map((span) => {
      const rec = (span && typeof span === "object") ? span as Record<string, unknown> : {};
      return { ...rec, sourceId: source.id };
    }),
    unbounded,
  );
}

function shiftToOrigin(spans: VisualSpan[], fetchStart: number, windowStart: number, windowEnd: number): VisualSpan[] {
  const shifted = spans.map((span) => ({
    ...span,
    start: span.start + fetchStart,
    end: span.end + fetchStart,
  }));
  return shifted
    .map((span) => ({
      ...span,
      start: Math.max(span.start, windowStart),
      end: Math.min(span.end, windowEnd),
    }))
    .filter((span) => span.end > span.start);
}

export async function describeSource(
  source: Source,
  dir: string,
  signal: AbortSignal,
  deps?: DescribeDeps,
): Promise<VisualSpan[]> {
  if (!source.hasVideo) return [];
  const client = deps?.client ?? new ZaiClient();
  const exec = deps?.exec ?? new SpawnExecutor();
  const cacheDir = join(analysisCacheDir(dir, source.sha256), "visual");
  await mkdir(cacheDir, { recursive: true });
  const proxy = join(cacheDir, "proxy.mp4");
  const hasProxy = await access(proxy).then(() => true, () => false);
  if (!hasProxy) {
    const made = await exec.run({
      command: "ffmpeg",
      args: [
        "-n", "-i", source.path,
        "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        proxy,
      ],
    });
    if (made.code !== 0) {
      throw new Error(`proxy visual falhou (código ${made.code})`);
    }
  }

  const collected: VisualSpan[] = [];
  for (const window of visualWindows(source.durationSeconds)) {
    if (signal.aborted) break;
    const cacheFile = join(cacheDir, `w-${window.start}-${window.end}.json`);
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8")) as VisualSpan[];
      collected.push(...cached);
      continue;
    } catch {
      // cache miss
    }
    const bytes = await readFile(proxy).catch(() => Buffer.from(""));
    const dataUrl = `data:video/mp4;base64,${bytes.toString("base64")}`;
    try {
      const text = await client.send([
        { type: "video_url", video_url: { url: dataUrl } },
        {
          type: "text",
          text: `${VISUAL_PROMPT}\n\njanela local: ${window.fetchStart}s → ${window.end}s (contexto incluso)\n`
            + `descreva só [${window.start}, ${window.end}) na origem da fonte.`,
        },
      ], signal);
      const origin = shiftToOrigin(parseSpans(text, source), window.fetchStart, window.start, window.end)
        .map((span, i) => ({ ...span, id: `${source.id}:w${window.start}:${i}` }));
      validateVisual(origin, source);
      await writeFile(cacheFile, `${JSON.stringify(origin)}\n`, "utf8");
      collected.push(...origin);
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }
  }
  return mergeAdjacent(collected);
}
