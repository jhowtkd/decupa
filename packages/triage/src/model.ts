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

/**
 * A única superfície que fala com um LLM. Tudo o mais no pacote é função pura
 * sobre o índice, e por isso testa offline.
 */
export interface TriageModel {
  structure(req: StructureRequest): Promise<StructureClaim[]>;
  density(req: DensityRequest): Promise<DensityCandidate[]>;
}

/** Devolve respostas roteirizadas — inclusive erradas, de propósito. */
export class FakeTriageModel implements TriageModel {
  readonly calls: { kind: "structure" | "density"; req: StructureRequest | DensityRequest }[] = [];
  private readonly claims: StructureClaim[];
  private readonly candidates: DensityCandidate[];

  constructor(claims: StructureClaim[] = [], candidates: DensityCandidate[] = []) {
    this.claims = claims;
    this.candidates = candidates;
  }

  async structure(req: StructureRequest): Promise<StructureClaim[]> {
    this.calls.push({ kind: "structure", req });
    return this.claims;
  }

  async density(req: DensityRequest): Promise<DensityCandidate[]> {
    this.calls.push({ kind: "density", req });
    return this.candidates;
  }
}
