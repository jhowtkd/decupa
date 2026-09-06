import {
  flagsFor,
  nearestSample,
  parseVisualIndex,
  sampleLooksBadAtJoin,
  type VisualSample,
  type VisualUnitFlags,
} from "@decupa/triage";

export interface ReviewUnitFlag {
  code: string;
  source: string;
  message: string;
}

export interface ReviewUnit {
  id: string;
  text: string;
  kept: boolean;
  /** segundos de fonte; a página usa para ouvir o trecho sem virar timeline */
  start: number;
  end: number;
  flags: ReviewUnitFlag[];
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
  /** instantes de fonte da junção; o player toca ~0,7s de cada lado */
  sourceOut: number;
  sourceIn: number;
  flags: ReviewFlag[];
}

export interface Review {
  units: ReviewUnit[];
  joins: ReviewJoin[];
  outputSeconds: number;
  sourceSeconds: number;
}

function asVisual(raw: unknown): VisualUnitFlags[] {
  if (raw == null) return [];
  try {
    return parseVisualIndex(raw);
  } catch {
    return [];
  }
}

function visualFlagsFor(id: string, visual: VisualUnitFlags[]): ReviewUnitFlag[] {
  const v = flagsFor(id, visual);
  if (!v) return [];
  const out: ReviewUnitFlag[] = [];
  if (v.looksAway) {
    out.push({ code: "looks_away", source: "visual", message: "olhando para longe da câmera" });
  }
  if (v.handOnFace) {
    out.push({ code: "hand_on_face", source: "visual", message: "mão no rosto" });
  }
  if (v.noFace) {
    out.push({ code: "no_face", source: "visual", message: "rosto não visível" });
  }
  if (v.ambiguous && out.length === 0) {
    out.push({
      code: "looks_away",
      source: "visual",
      message: "faixa ambígua: possível olhar para o operador",
    });
  }
  return out;
}

function mergeFlags(base: ReviewUnitFlag[], extra: ReviewUnitFlag[] | undefined): ReviewUnitFlag[] {
  const out = [...(extra ?? [])];
  for (const f of base) {
    if (!out.some((x) => x.code === f.code && x.source === f.source)) out.push(f);
  }
  return out;
}

function describeJoin(incoming: VisualSample | undefined, outgoing: VisualSample | undefined): {
  message: string;
  hint: string;
} {
  if (incoming?.handOnFace) {
    return {
      message: "entra com a mão no rosto",
      hint: "entra com a mão no rosto; mova o in-point +0,4s",
    };
  }
  if (incoming?.lookDown) {
    return {
      message: "entra olhando para baixo",
      hint: "entra olhando para baixo; mova o in-point +0,4s",
    };
  }
  if (incoming && !incoming.face) {
    return {
      message: "entra sem rosto visível",
      hint: "entra sem rosto visível; mova o in-point +0,4s",
    };
  }
  if (outgoing?.handOnFace) {
    return {
      message: "sai com a mão no rosto",
      hint: "sai com a mão no rosto; mova o out-point −0,4s",
    };
  }
  if (outgoing?.lookDown) {
    return {
      message: "sai olhando para baixo",
      hint: "sai olhando para baixo; mova o out-point −0,4s",
    };
  }
  if (outgoing && !outgoing.face) {
    return {
      message: "sai sem rosto visível",
      hint: "sai sem rosto visível; mova o out-point −0,4s",
    };
  }
  return {
    message: "junção com problema visual",
    hint: "mova o in-point +0,4s",
  };
}

function visualInPointFlag(
  join: Record<string, any>,
  visual: VisualUnitFlags[],
): ReviewFlag | null {
  const sourceOut = Number(join.source_out);
  const sourceIn = Number(join.source_in);
  const outUnit = flagsFor(String(join.outgoing_unit ?? ""), visual);
  const inUnit = flagsFor(String(join.incoming_unit ?? ""), visual);
  const outSample = outUnit && Number.isFinite(sourceOut)
    ? nearestSample(outUnit.samples, sourceOut)
    : undefined;
  const inSample = inUnit && Number.isFinite(sourceIn)
    ? nearestSample(inUnit.samples, sourceIn)
    : undefined;
  if (!sampleLooksBadAtJoin(outSample) && !sampleLooksBadAtJoin(inSample)) return null;
  const { message, hint } = describeJoin(inSample, outSample);
  return {
    code: "visual_in_point",
    severity: "warning",
    message,
    hint,
  };
}

/**
 * O que a página consome: as unidades em ordem de fonte com o estado de cada
 * uma, mais as junções com o texto dos dois lados.
 *
 * As unidades dropadas vêm junto de propósito — é o que permite restaurar sem
 * ida ao servidor, e é o que faz o marcador colapsado poder mostrar o texto que
 * saiu. Sem isso, restaurar viraria caça ao tesouro entre marcadores idênticos.
 */
export function buildReview(
  rawPlan: unknown,
  rawIndex: unknown,
  rawVisual?: unknown,
  extraFlags?: Record<string, ReviewUnitFlag[]>,
): Review {
  const plan = rawPlan as Record<string, any>;
  const index = rawIndex as Record<string, any>;
  const visual = asVisual(rawVisual);

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
    .map((u) => {
      const id = String(u.id);
      return {
        id,
        text: String(u.text ?? ""),
        kept: kept.has(id),
        start: Number(u.start ?? 0),
        end: Number(u.end ?? 0),
        flags: mergeFlags(visualFlagsFor(id, visual), extraFlags?.[id]),
      };
    });

  const joins: ReviewJoin[] = (plan?.joins ?? []).map((j: Record<string, any>) => {
    const flags: ReviewFlag[] = (j.flags ?? []).map((f: Record<string, any>) => ({
      code: String(f.code ?? ""),
      severity: String(f.severity ?? "warning"),
      message: String(f.message ?? ""),
      hint: String(f.hint ?? ""),
    }));
    const visualFlag = visualInPointFlag(j, visual);
    if (visualFlag && !flags.some((f) => f.code === "visual_in_point")) flags.push(visualFlag);
    return {
      afterUnitId: String(j.outgoing_unit ?? ""),
      incomingUnitId: String(j.incoming_unit ?? ""),
      removedSeconds: Number(j.removed_seconds ?? 0),
      outgoingTail: String(j.outgoing_tail ?? ""),
      incomingHead: String(j.incoming_head ?? ""),
      sourceOut: Number(j.source_out ?? 0),
      sourceIn: Number(j.source_in ?? 0),
      flags,
    };
  });

  return {
    units,
    joins,
    outputSeconds: Number(plan?.output_duration ?? 0),
    sourceSeconds: Number(plan?.source_duration ?? 0),
  };
}
