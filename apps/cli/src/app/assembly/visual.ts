import { normalizeRanges } from "./words.ts";
import { fixtureAssembly } from "./fixture.ts";
import type { Analysis, Source, SourceRange, VisualSpan } from "./types.ts";

const CONFIDENCE = new Set(["observed", "uncertain", "unavailable"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateVisual(raw: unknown, source: Source): VisualSpan[] {
  if (!Array.isArray(raw)) throw new Error("mapa visual precisa ser um array");
  const spans: VisualSpan[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item)) throw new Error(`observação ${i} precisa ser um objeto`);
    const sourceId = String(item.sourceId ?? "");
    if (sourceId !== source.id) {
      throw new Error(`observação ${i} referencia fonte inventada ${sourceId}`);
    }
    const id = String(item.id ?? `${source.id}:${i}`);
    if (seen.has(id)) throw new Error(`observação ${i} com id duplicado: ${id}`);
    seen.add(id);
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`observação ${i} tem intervalo inválido`);
    }
    if (start < 0) {
      throw new Error(`observação ${i} começa antes da fonte ${source.id}`);
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
      id,
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

/**
 * Cobertura real da análise visual: cada segundo solicitado vira uma célula;
 * segundo sem nenhuma evidência (nem `unavailable` explícito) é lacuna.
 * Zero descrições significa zero segundos examinados — nunca cobertura total.
 */
export function visualCoverage(spans: VisualSpan[], duration: number): Analysis["visualCoverage"] {
  const requested: SourceRange[] = [];
  for (let start = 0; start < duration; start += 1) {
    requested.push({ start, end: Math.min(start + 1, duration) });
  }
  const returned = normalizeRanges(
    spans.map((span) => ({ start: Math.max(0, span.start), end: Math.min(span.end, duration) })),
  ).filter((range) => range.start < range.end);
  const missing = requested.filter((cell) =>
    !returned.some((range) => range.start < cell.end && cell.start < range.end)
  );
  return { requested, returned, missing };
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
