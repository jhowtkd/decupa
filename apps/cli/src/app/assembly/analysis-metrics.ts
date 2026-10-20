import { cacheConfigKey, type OperationMetrics } from "@decupa/bench";
import type { Executor } from "../pipeline.ts";
import { analyzeSource, type AnalyzeOptions } from "./analysis.ts";
import type { Analysis, Source } from "./types.ts";

/** Same derivative identity for preparation, automatic ASR and template caches. */
export function analysisMetricConfigKey(key: string): string {
  return cacheConfigKey({ version: "analysis-v2", key });
}

export function createAnalysisMetrics(source: Source, metrics: Pick<OperationMetrics, "emit">) {
  const started = performance.now();
  let builtAt: number | undefined;
  let recorded = false;
  const emit = (key: string | null, outcome: "built" | "hit" | "hit-or-shared" | "error" | "not-applicable"): void => {
    if (recorded) return;
    recorded = true;
    metrics.emit("cache", { stage: "analysis", sourceId: source.id, sha256: source.sha256,
      configKey: key === null ? null : analysisMetricConfigKey(key), outcome,
      durationMs: builtAt !== undefined ? Math.max(0, performance.now() - builtAt)
        : outcome === "error" ? 0 : Math.max(0, performance.now() - started) });
  };
  return {
    onStage(stage: Parameters<NonNullable<AnalyzeOptions["onStage"]>>[0]): void {
      if (stage !== "queued") builtAt ??= performance.now();
    },
    finish(result: Pick<Analysis, "key" | "status">): void {
      emit(result.key, result.status !== "ready" ? "error" : !source.hasAudio ? "not-applicable"
        : builtAt === undefined ? "hit-or-shared" : "built");
    },
    hit(key: string): void { emit(key, source.hasAudio ? "hit" : "not-applicable"); },
    fail(): void { emit(null, "error"); },
  };
}

/** Observe the analysis call only; downstream save failures cannot duplicate its event. */
export async function analyzeSourceWithMetrics(
  source: Source, dir: string, exec: Executor, options: AnalyzeOptions,
  metrics: Pick<OperationMetrics, "emit">,
): Promise<Analysis> {
  const cache = createAnalysisMetrics(source, metrics);
  try {
    const result = await analyzeSource(source, dir, exec, { ...options, onStage: stage => {
      cache.onStage(stage);
      options.onStage?.(stage);
    } });
    cache.finish(result);
    return result;
  } catch (error) { cache.fail(); throw error; }
}
