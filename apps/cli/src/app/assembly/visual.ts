import { fixtureAssembly } from "./fixture.ts";
import type { Source, VisualSpan } from "./types.ts";

const CONFIDENCE = new Set(["observed", "uncertain", "unavailable"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateVisual(raw: unknown, source: Source): VisualSpan[] {
  if (!Array.isArray(raw)) throw new Error("mapa visual precisa ser um array");
  const spans: VisualSpan[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item)) throw new Error(`observação ${i} precisa ser um objeto`);
    const sourceId = String(item.sourceId ?? "");
    if (sourceId !== source.id) {
      throw new Error(`observação ${i} referencia fonte inventada ${sourceId}`);
    }
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`observação ${i} tem intervalo inválido`);
    }
    if (end > source.durationSeconds + 1e-9) {
      throw new Error(`observação ${i} termina depois da fonte ${source.id}`);
    }
    if (end <= start) throw new Error(`observação ${i} tem duração inválida`);
    const confidence = String(item.confidence ?? "");
    if (!CONFIDENCE.has(confidence)) {
      throw new Error(`observação ${i} tem confiança inválida`);
    }
    spans.push({
      id: String(item.id ?? `${source.id}:${i}`),
      sourceId,
      start,
      end,
      text: String(item.text ?? ""),
      confidence: confidence as VisualSpan["confidence"],
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    });
  }
  return spans;
}

/** Consulta semiaberta: o segundo N cobre [N, N+1). */
export function visualAt(spans: VisualSpan[], second: number): VisualSpan[] {
  if (!Number.isFinite(second) || second < 0) {
    throw new Error("segundo de consulta inválido");
  }
  return spans.filter((span) => span.start <= second && second < span.end);
}

export function mergeAdjacent(spans: VisualSpan[]): VisualSpan[] {
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: VisualSpan[] = [];
  for (const span of ordered) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.sourceId === span.sourceId &&
      prev.confidence === "observed" &&
      span.confidence === "observed" &&
      prev.text === span.text &&
      Math.abs(prev.end - span.start) < 1e-9
    ) {
      prev.end = span.end;
      continue;
    }
    out.push({ ...span, tags: [...span.tags] });
  }
  return out;
}

export function visualWindows(durationSeconds: number): { start: number; end: number; fetchStart: number }[] {
  const WINDOW = 20;
  const CONTEXT = 1;
  const windows = [];
  for (let start = 0; start < durationSeconds; start += WINDOW) {
    const end = Math.min(durationSeconds, start + WINDOW);
    windows.push({
      start,
      end,
      fetchStart: start === 0 ? 0 : Math.max(0, start - CONTEXT),
    });
  }
  return windows;
}

export function fixtureSourceA(): Source {
  return fixtureAssembly().sources[0]!;
}
