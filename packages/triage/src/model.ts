import type { StructureClaim } from "./claims.ts";

export interface StructureRequest {
  unitsBlock: string;
  videoPath: string;
}

export interface DensityRequest {
  unitsBlock: string;
  videoPath: string;
  budgetSeconds: number;
}

export interface DensityCandidate {
  unit_ids: string[];
  note: string;
  /** 1 é o primeiro a sair. */
  rank: number;
}

export interface InspectRequest {
  unitId: string;
  /** JPEG file paths, 3–4 frames from that unit only */
  frames: string[];
}

export interface InspectVerdict {
  unitId: string;
  /** drop | keep | unsure */
  decision: "drop" | "keep" | "unsure";
  note: string;
}

/**
 * A única superfície que fala com um LLM. Tudo o mais no pacote é função pura
 * sobre o índice, e por isso testa offline.
 */
export interface TriageModel {
  structure(req: StructureRequest): Promise<StructureClaim[]>;
  density(req: DensityRequest): Promise<DensityCandidate[]>;
  inspect(req: InspectRequest): Promise<InspectVerdict>;
}

/** Devolve respostas roteirizadas — inclusive erradas, de propósito. */
export class FakeTriageModel implements TriageModel {
  readonly calls: {
    kind: "structure" | "density" | "inspect";
    req: StructureRequest | DensityRequest | InspectRequest;
  }[] = [];
  private readonly claims: StructureClaim[];
  private readonly candidates: DensityCandidate[];
  private readonly inspectById: Map<string, InspectVerdict>;

  constructor(
    claims: StructureClaim[] = [],
    candidates: DensityCandidate[] = [],
    inspect: InspectVerdict[] = [],
  ) {
    this.claims = claims;
    this.candidates = candidates;
    this.inspectById = new Map(inspect.map((v) => [v.unitId, v]));
  }

  async structure(req: StructureRequest): Promise<StructureClaim[]> {
    this.calls.push({ kind: "structure", req });
    return this.claims;
  }

  async density(req: DensityRequest): Promise<DensityCandidate[]> {
    this.calls.push({ kind: "density", req });
    return this.candidates;
  }

  async inspect(req: InspectRequest): Promise<InspectVerdict> {
    this.calls.push({ kind: "inspect", req });
    return this.inspectById.get(req.unitId) ?? {
      unitId: req.unitId,
      decision: "unsure",
      note: "fake: sem veredito roteirizado",
    };
  }
}
