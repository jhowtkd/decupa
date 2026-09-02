import { mergeIntervals, totalDurationMs, type Interval } from "@decupa/core";

export interface IntervalScore {
  /** Fração dos ms preditos que caem dentro da verdade. */
  precisionMs: number;
  /** Fração dos ms da verdade que foram preditos. */
  recallMs: number;
  f1: number;
  iou: number;
  predictedMs: number;
  truthMs: number;
  intersectionMs: number;
}

function intersectionMs(a: Interval[], b: Interval[]): number {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  let total = 0;
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.startMs, right[j]!.startMs);
    const end = Math.min(left[i]!.endMs, right[j]!.endMs);
    if (end > start) total += end - start;
    if (left[i]!.endMs < right[j]!.endMs) i++;
    else j++;
  }

  return total;
}

export function scoreIntervals(opts: {
  predicted: Interval[];
  truth: Interval[];
}): IntervalScore {
  const predictedMs = totalDurationMs(opts.predicted);
  const truthMs = totalDurationMs(opts.truth);
  const overlap = intersectionMs(opts.predicted, opts.truth);
  const unionMs = predictedMs + truthMs - overlap;

  // Nada predito e nada esperado é acerto perfeito, não divisão por zero.
  const precisionMs = predictedMs === 0 ? (truthMs === 0 ? 1 : 0) : overlap / predictedMs;
  const recallMs = truthMs === 0 ? (predictedMs === 0 ? 1 : 0) : overlap / truthMs;
  const f1 = precisionMs + recallMs === 0 ? 0 : (2 * precisionMs * recallMs) / (precisionMs + recallMs);
  const iou = unionMs === 0 ? 1 : overlap / unionMs;

  return { precisionMs, recallMs, f1, iou, predictedMs, truthMs, intersectionMs: overlap };
}
