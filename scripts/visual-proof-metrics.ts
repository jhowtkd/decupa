import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { VisualMetric } from "../apps/cli/src/app/assembly/model.ts";
import { hashFile } from "../packages/media/src/index.ts";

export type Counters = {
  sends: number; framesSent: number; httpAttempts: number; passes: number[];
  extractMs: number; requestMs: number; queueMs: number; totalMs: number;
  cacheHitWindows: number; windowMetrics: VisualMetric[];
};
export function emptyCounters(): Counters {
  return { sends: 0, framesSent: 0, httpAttempts: 0, passes: [], extractMs: 0,
    requestMs: 0, queueMs: 0, totalMs: 0, cacheHitWindows: 0, windowMetrics: [] };
}
export function countImages(content: unknown[]): number {
  return content.filter((part) => (part as { type?: string }).type === "image_url").length;
}
export function recordMetric(counters: Counters, event: VisualMetric) {
  counters.windowMetrics.push(event);
  if (event.phase === "extract") counters.extractMs += event.elapsedMs;
  if (event.phase === "request") counters.requestMs += event.elapsedMs;
  counters.queueMs += event.queueMs;
  if (event.phase === "total") {
    counters.totalMs += event.elapsedMs;
    if (event.outcome === "cache-hit") counters.cacheHitWindows += 1;
  }
}
export function sumMetrics(counters: Counters, events: VisualMetric[]) {
  for (const event of events) recordMetric(counters, event);
}
export const round2 = (value: number): number => Math.round(value * 100) / 100;
export const hashValue = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function proofGitState(): Promise<{ commit: string | null; dirty: boolean | null }> {
  try {
    const [head, status] = await Promise.all([
      promisify(execFile)("git", ["rev-parse", "HEAD"]),
      promisify(execFile)("git", ["status", "--porcelain"]),
    ]);
    return { commit: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
  } catch { return { commit: null, dirty: null }; }
}
/** Reparo JSON é outro send, com seu próprio retry HTTP: até quatro requests por janela. */
export function estimateCalls(arm: string, windows: number): string {
  return `${windows}–${4 * windows} chamadas HTTP (inclui ${arm === "two-pass" ? "2 passadas" : "reparo JSON"} e até 1 retry por envio; adaptações do provedor geral podem acrescentar chamadas)`;
}

export async function corpusProvenance(sources: { id: string; path: string; sha256: string }[], injected: boolean) {
  return Promise.all(sources.map(async source => {
    const actualSha256 = await hashFile(source.path).catch(error => {
      if (injected && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (actualSha256 && actualSha256 !== source.sha256) throw Error(`fonte ${source.id} mudou desde a importação; ensaio recusado`);
    return { id: source.id, sha256: source.sha256, actualSha256, verified: actualSha256 !== null };
  }));
}

/** Soma de janelas paralelas serve para diagnóstico; o wall principal continua no runner. */
export async function measureWindow<T>(counters: Counters, sourceId: string, window: { start: number; end: number }, work: () => Promise<T>): Promise<T> {
  const started = performance.now(), eventStart = counters.windowMetrics.length;
  let outcome: VisualMetric["outcome"] = "ok";
  try { return await work(); }
  catch (error) { outcome = "error"; throw error; }
  finally {
    const requests = counters.windowMetrics.slice(eventStart).filter(event => event.sourceId === sourceId && event.windowStart === window.start && event.phase === "request");
    recordMetric(counters, { sourceId, windowStart: window.start, windowEnd: window.end, phase: "total", outcome,
      elapsedMs: performance.now() - started, queueMs: 0, frames: requests.at(-1)?.frames ?? 0,
      attempt: requests.length, httpAttempts: requests.reduce((sum, event) => sum + (event.httpAttempts ?? 0), 0) });
  }
}
