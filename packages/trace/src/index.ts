export type TracePhase = "queued" | "started" | "finished";
export type TraceCategory = "ok" | "error" | "cancelled";

export interface TraceEvent {
  attemptId: string;
  stage: string;
  phase: TracePhase;
  atMs: number;
  durationMs?: number;
  category?: TraceCategory;
}

export interface TraceSink {
  emit(event: TraceEvent): void | Promise<void>;
}

export interface TraceRunOptions {
  signal?: AbortSignal;
  wait?: () => Promise<void> | void;
}

export interface Tracer {
  run<T>(stage: string, work: () => Promise<T> | T, opts?: TraceRunOptions): Promise<T>;
}

const PHASES = new Set<TracePhase>(["queued", "started", "finished"]);
const CATEGORIES = new Set<TraceCategory>(["ok", "error", "cancelled"]);

export class CancelledError extends Error {
  readonly name = "CancelledError";
  constructor(message = "operação cancelada") {
    super(message);
  }
}

export function isCancelledError(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "CancelledError";
}

function nowMs(): number {
  return Date.now();
}

function asCancelled(error: unknown): CancelledError {
  if (error instanceof CancelledError) return error;
  const cancelled = new CancelledError();
  if (error instanceof Error) cancelled.cause = error;
  return cancelled;
}

export function sanitizeTraceEvent(raw: unknown): TraceEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.attemptId !== "string" || rec.attemptId.length === 0) return null;
  if (typeof rec.stage !== "string" || rec.stage.length === 0) return null;
  if (typeof rec.phase !== "string" || !PHASES.has(rec.phase as TracePhase)) return null;
  if (typeof rec.atMs !== "number" || !Number.isFinite(rec.atMs)) return null;
  const event: TraceEvent = {
    attemptId: rec.attemptId,
    stage: rec.stage,
    phase: rec.phase as TracePhase,
    atMs: rec.atMs,
  };
  if (typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs) && rec.durationMs >= 0) {
    event.durationMs = rec.durationMs;
  }
  if (typeof rec.category === "string" && CATEGORIES.has(rec.category as TraceCategory)) {
    event.category = rec.category as TraceCategory;
  }
  return event;
}

function silentEmit(sink: TraceSink | undefined, event: TraceEvent): void {
  const clean = sanitizeTraceEvent(event);
  if (!clean) return;
  try {
    const result = sink?.emit(clean);
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Falha do coletor nunca interrompe a edição.
  }
}

export function collectSink(): { events: TraceEvent[]; emit(event: TraceEvent): void } {
  const events: TraceEvent[] = [];
  return {
    events,
    emit(event: TraceEvent) {
      const clean = sanitizeTraceEvent(event);
      if (clean) events.push(clean);
    },
  };
}

export function createTracer(sink?: TraceSink): Tracer {
  return {
    async run<T>(stage: string, work: () => Promise<T> | T, opts?: TraceRunOptions): Promise<T> {
      const attemptId = crypto.randomUUID();
      silentEmit(sink, { attemptId, stage, phase: "queued", atMs: nowMs() });
      const finish = (category: TraceCategory, startedAt?: number): void => {
        const atMs = nowMs();
        silentEmit(sink, {
          attemptId,
          stage,
          phase: "finished",
          atMs,
          category,
          ...(startedAt !== undefined ? { durationMs: Math.max(0, atMs - startedAt) } : { durationMs: 0 }),
        });
      };
      try {
        if (opts?.signal?.aborted) throw asCancelled(opts.signal.reason);
        await opts?.wait?.();
        if (opts?.signal?.aborted) throw asCancelled(opts.signal.reason);
      } catch (error) {
        const cancelled = isCancelledError(error) || Boolean(opts?.signal?.aborted);
        finish(cancelled ? "cancelled" : "error");
        throw cancelled ? asCancelled(error) : error;
      }
      const startedAt = nowMs();
      silentEmit(sink, { attemptId, stage, phase: "started", atMs: startedAt });
      try {
        const result = await work();
        finish("ok", startedAt);
        return result;
      } catch (error) {
        finish(isCancelledError(error) ? "cancelled" : "error", startedAt);
        throw isCancelledError(error) ? asCancelled(error) : error;
      }
    },
  };
}
