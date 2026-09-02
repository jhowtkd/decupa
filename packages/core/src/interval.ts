/** Intervalo de tempo em milissegundos inteiros. Meio-aberto: [startMs, endMs). */
export interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Ordena, funde sobreposições e junta vizinhos separados por até
 * `gapToleranceMs`. Não muta a entrada.
 */
export function mergeIntervals(
  intervals: Interval[],
  gapToleranceMs = 0,
): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.startMs - last.endMs <= gapToleranceMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/** Duração total coberta, sem contar sobreposição duas vezes. */
export function totalDurationMs(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce(
    (sum, i) => sum + (i.endMs - i.startMs),
    0,
  );
}
