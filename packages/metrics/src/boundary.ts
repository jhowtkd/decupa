export interface BoundaryError {
  /** Quantas fronteiras da verdade acharam par dentro da tolerância. */
  n: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  meanMs: number;
  /** Fronteiras da verdade sem nenhuma predição perto. */
  unmatched: number;
}

/** Percentil por interpolação de índice mais próximo, sobre lista ordenada. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

/**
 * Erro de fronteira: para cada tempo em `truth`, a distância até o tempo mais
 * próximo em `predicted`. Fronteiras sem par dentro de `toleranceMs` viram
 * `unmatched` em vez de inflar os percentis com um número arbitrário.
 */
export function boundaryError(opts: {
  predicted: number[];
  truth: number[];
  toleranceMs?: number;
}): BoundaryError {
  const toleranceMs = opts.toleranceMs ?? 500;
  const predicted = [...opts.predicted].sort((a, b) => a - b);

  const errors: number[] = [];
  let unmatched = 0;

  for (const target of opts.truth) {
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of predicted) {
      const distance = Math.abs(candidate - target);
      if (distance < best) best = distance;
      // predicted está ordenado: passou do alvo, só piora daqui.
      if (candidate > target && distance > best) break;
    }
    if (best <= toleranceMs) errors.push(best);
    else unmatched++;
  }

  errors.sort((a, b) => a - b);
  const mean = errors.length === 0
    ? 0
    : errors.reduce((sum, e) => sum + e, 0) / errors.length;

  return {
    n: errors.length,
    p50Ms: percentile(errors, 0.5),
    p90Ms: percentile(errors, 0.9),
    maxMs: errors.length === 0 ? 0 : errors[errors.length - 1]!,
    meanMs: mean,
    unmatched,
  };
}
