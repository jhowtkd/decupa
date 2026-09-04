export interface ReviewUnit {
  id: string;
  text: string;
  kept: boolean;
}

export interface ReviewFlag {
  code: string;
  severity: string;
  message: string;
  hint: string;
}

export interface ReviewJoin {
  afterUnitId: string;
  incomingUnitId: string;
  removedSeconds: number;
  /** as últimas palavras antes do corte */
  outgoingTail: string;
  /** as primeiras depois */
  incomingHead: string;
  flags: ReviewFlag[];
}

export interface Review {
  units: ReviewUnit[];
  joins: ReviewJoin[];
  outputSeconds: number;
  sourceSeconds: number;
}

/**
 * O que a página consome: as unidades em ordem de fonte com o estado de cada
 * uma, mais as junções com o texto dos dois lados.
 *
 * As unidades dropadas vêm junto de propósito — é o que permite restaurar sem
 * ida ao servidor, e é o que faz o marcador colapsado poder mostrar o texto que
 * saiu. Sem isso, restaurar viraria caça ao tesouro entre marcadores idênticos.
 */
export function buildReview(rawPlan: unknown, rawIndex: unknown): Review {
  const plan = rawPlan as Record<string, any>;
  const index = rawIndex as Record<string, any>;

  const rawUnits = index?.units;
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) {
    throw new Error("índice sem `units` — rode `condense.py index` antes");
  }

  const kept = new Set<string>();
  for (const clip of plan?.clips ?? []) {
    for (const id of clip.unit_ids ?? []) kept.add(String(id));
  }

  const units: ReviewUnit[] = [...rawUnits]
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((u) => ({ id: String(u.id), text: String(u.text ?? ""), kept: kept.has(String(u.id)) }));

  const joins: ReviewJoin[] = (plan?.joins ?? []).map((j: Record<string, any>) => ({
    afterUnitId: String(j.outgoing_unit ?? ""),
    incomingUnitId: String(j.incoming_unit ?? ""),
    removedSeconds: Number(j.removed_seconds ?? 0),
    outgoingTail: String(j.outgoing_tail ?? ""),
    incomingHead: String(j.incoming_head ?? ""),
    // Os flags do motor são objetos {code, severity, message, hint}. O `hint`
    // diz o que fazer a respeito, então achatar para string perde a única
    // parte acionável.
    flags: (j.flags ?? []).map((f: Record<string, any>) => ({
      code: String(f.code ?? ""),
      severity: String(f.severity ?? "warning"),
      message: String(f.message ?? ""),
      hint: String(f.hint ?? ""),
    })),
  }));

  return {
    units,
    joins,
    outputSeconds: Number(plan?.output_duration ?? 0),
    sourceSeconds: Number(plan?.source_duration ?? 0),
  };
}
