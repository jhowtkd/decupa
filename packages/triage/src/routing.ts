import { createLimitedQueue } from "@decupa/queue";
import { createTracer, type Tracer } from "@decupa/trace";
import { TypeSafeHttpError } from "@decupa/typesafe";
import { acceptedDropIds, verifyClaims, type StructureClaim, type Verdict } from "./claims.ts";
import { buildEditCatalog, type EditCandidate, type EditCatalog } from "./catalog.ts";
import { keepListFrom } from "./keeplist.ts";
import { mechanicalClaims } from "./mechanical.ts";
import type { TriageModel } from "./model.ts";
import type { SpeechIndex } from "./speech-index.ts";

export type RouteMode = "off" | "observe" | "hybrid";

export type FastDecision = {
  applyIds: readonly string[];
};

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: { threshold?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.threshold = opts.threshold ?? 1;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  get open(): boolean {
    return this.failures >= this.threshold && this.now() - this.openedAt < this.cooldownMs;
  }

  fail(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  succeed(): void {
    this.failures = 0;
    this.openedAt = 0;
  }
}

export type RouteOptions = {
  mode: RouteMode;
  index: SpeechIndex;
  model: TriageModel;
  unitsBlock?: string;
  videoPath?: string;
  decide?: (catalog: EditCatalog) => FastDecision | null | Promise<FastDecision | null>;
  circuit?: CircuitBreaker;
  tracer?: Tracer;
  now?: () => number;
};

export type RouteResult = {
  keepList: string;
  structureCalls: number;
  elapsedMs: number;
  source: "legacy" | "fast" | "fallback";
  circuitOpen: boolean;
  verdicts: Verdict[];
};

const structureQueue = createLimitedQueue(1);

function isUnavailable(error: unknown): boolean {
  if (error instanceof TypeSafeHttpError) return error.status === 429 || error.status === 529;
  return false;
}

function claimFromCandidate(candidate: EditCandidate): StructureClaim | null {
  if (candidate.protected) return null;
  switch (candidate.kind) {
    case "prefix":
      return {
        unit_ids: candidate.unitIds,
        reason: "preroll",
        restated_by: null,
        note: candidate.id,
        source: "model",
      };
    case "suffix":
      return {
        unit_ids: candidate.unitIds,
        reason: "postroll",
        restated_by: null,
        note: candidate.id,
        source: "model",
      };
    case "retake":
      return {
        unit_ids: candidate.unitIds,
        reason: "retake",
        restated_by: candidate.replacement,
        note: candidate.id,
        source: "model",
      };
    case "gap":
      return {
        unit_ids: candidate.unitIds,
        reason: "aside",
        restated_by: null,
        note: candidate.id,
        source: "model",
      };
    default:
      return null;
  }
}

async function legacyStructure(
  model: TriageModel,
  unitsBlock: string,
  videoPath: string,
): Promise<{ claims: StructureClaim[]; calls: number }> {
  const claims = await structureQueue.run(
    () => model.structure({ unitsBlock, videoPath }),
    { key: `structure:${videoPath}` },
  );
  return { claims, calls: 1 };
}

export async function routeTriage(opts: RouteOptions): Promise<RouteResult> {
  const now = opts.now ?? Date.now;
  const tracer = opts.tracer ?? createTracer();
  const started = now();
  return tracer.run("route", async () => {
    const mechanicalVerdicts = verifyClaims(mechanicalClaims(opts.index), opts.index);
    const dropped = acceptedDropIds(mechanicalVerdicts);
    const circuit = opts.circuit;
    const circuitOpen = Boolean(circuit?.open);

    const finish = (
      source: RouteResult["source"],
      extra: Verdict[],
      structureCalls: number,
    ): RouteResult => {
      const verdicts = [...mechanicalVerdicts, ...extra];
      for (const id of acceptedDropIds(extra)) dropped.add(id);
      return {
        keepList: keepListFrom(opts.index, dropped),
        structureCalls,
        elapsedMs: Math.max(0, now() - started),
        source,
        circuitOpen: Boolean(circuit?.open),
        verdicts,
      };
    };

    const runLegacy = async (source: "legacy" | "fallback"): Promise<RouteResult> => {
      const { claims, calls } = await legacyStructure(
        opts.model,
        opts.unitsBlock ?? "",
        opts.videoPath ?? "",
      );
      const extra = verifyClaims(claims, opts.index, dropped);
      return finish(source, extra, calls);
    };

    if (opts.mode === "off" || circuitOpen) {
      return runLegacy(circuitOpen && opts.mode === "hybrid" ? "fallback" : "legacy");
    }

    const catalog = await buildEditCatalog(opts.index, { alreadyDropped: dropped });

    let decision: FastDecision | null = null;
    try {
      decision = opts.decide ? await opts.decide(catalog) : null;
      circuit?.succeed();
    } catch (error) {
      if (isUnavailable(error)) circuit?.fail();
      else if (opts.mode === "hybrid") throw error;
      decision = null;
    }

    if (opts.mode === "observe") {
      return runLegacy("legacy");
    }

    if (decision) {
      const apply = new Set(decision.applyIds);
      const reconstructed: StructureClaim[] = [];
      for (const candidate of catalog.candidates) {
        if (!apply.has(candidate.id)) continue;
        const claim = claimFromCandidate(candidate);
        if (!claim) continue;
        reconstructed.push(claim);
      }
      const extra = verifyClaims(reconstructed, opts.index, dropped);
      return finish("fast", extra, 0);
    }

    return runLegacy("fallback");
  });
}
