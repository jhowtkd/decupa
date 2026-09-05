import { verifyClaims, type StructureClaim } from "./claims.ts";
import type { InspectVerdict } from "./model.ts";
import {
  MOTOR_DUPLICATE_THRESHOLD,
  characterSimilarity,
  isRestatement,
} from "./similarity.ts";
import type { IndexUnit, SpeechIndex } from "./speech-index.ts";
import type { VisualUnitFlags } from "./visual.ts";

export interface InspectFlag {
  unitId: string;
  code: string;
  source: "visual";
  message: string;
}

export interface InspectOutcome {
  /** Só entra claim com take substituto que `verifyClaims` aceita. */
  claims: StructureClaim[];
  flags: InspectFlag[];
}

function motorBetween(a: IndexUnit, b: IndexUnit): number | null {
  if (a.nearDuplicateOf === b.id && a.similarity != null) return a.similarity;
  if (b.nearDuplicateOf === a.id && b.similarity != null) return b.similarity;
  return null;
}

/** Take posterior que ainda fica e restabelece a frase. Sem isso, inspect não dropa. */
function laterSubstitute(
  unit: IndexUnit,
  index: SpeechIndex,
  dropped: Set<string>,
): IndexUnit | null {
  for (const other of index.units) {
    if (other.id === unit.id || dropped.has(other.id)) continue;
    if (other.index <= unit.index) continue;
    const motor = motorBetween(unit, other);
    if (
      isRestatement(unit.text, other.text, motor)
      || characterSimilarity(unit.text, other.text) >= MOTOR_DUPLICATE_THRESHOLD
    ) {
      return other;
    }
  }
  return null;
}

export function normalizeInspectVerdict(raw: unknown, unitId: string): InspectVerdict {
  const o = (raw ?? {}) as Record<string, unknown>;
  const d = o.decision;
  const decision = d === "drop" || d === "keep" || d === "unsure" ? d : "unsure";
  return {
    unitId: String(o.unitId ?? o.unit_id ?? unitId),
    decision,
    note: String(o.note ?? ""),
  };
}

/**
 * Confirma faixa ambígua. Drop automático só com retake substituto que confere;
 * sem substituto, só flag.
 */
export function applyInspect(
  verdicts: InspectVerdict[],
  index: SpeechIndex,
  alreadyDropped: Set<string>,
): InspectOutcome {
  const claims: StructureClaim[] = [];
  const flags: InspectFlag[] = [];
  const occupied = new Set(alreadyDropped);

  for (const verdict of verdicts) {
    if (occupied.has(verdict.unitId)) continue;
    const unit = index.units.find((u) => u.id === verdict.unitId);
    if (!unit) continue;

    if (verdict.decision === "keep") continue;

    if (verdict.decision === "drop") {
      const sub = laterSubstitute(unit, index, occupied);
      if (sub) {
        const claim: StructureClaim = {
          unit_ids: [unit.id],
          reason: "retake",
          restated_by: sub.id,
          note: verdict.note || `inspect: olhando para o operador; fica ${sub.id}`,
          source: "visual",
        };
        const [v] = verifyClaims([claim], index);
        if (v?.accepted) {
          claims.push(claim);
          occupied.add(unit.id);
          continue;
        }
      }
      flags.push({
        unitId: unit.id,
        code: "looks_away",
        source: "visual",
        message: verdict.note || "inspect: olhando para o operador, sem take substituto",
      });
      continue;
    }

    flags.push({
      unitId: unit.id,
      code: "looks_away",
      source: "visual",
      message: verdict.note || "inspect: faixa ambígua, para revisão",
    });
  }

  return { claims, flags };
}

/** Visual ruim ou ambíguo que não saiu: olhe isto, não corte. */
export function flagsWithoutSubstitute(
  visual: VisualUnitFlags[],
  dropped: Set<string>,
  inspectFlags: InspectFlag[],
  inspectKept: Set<string> = new Set(),
): InspectFlag[] {
  const out = [...inspectFlags];
  const seen = new Set(out.map((f) => f.unitId));
  for (const id of inspectKept) seen.add(id);

  for (const u of visual) {
    if (dropped.has(u.id) || seen.has(u.id)) continue;
    if (u.looksAway) {
      out.push({
        unitId: u.id,
        code: "looks_away",
        source: "visual",
        message: "olhando para longe da câmera, sem take substituto",
      });
    } else if (u.handOnFace) {
      out.push({
        unitId: u.id,
        code: "hand_on_face",
        source: "visual",
        message: "mão no rosto, sem take substituto",
      });
    } else if (u.noFace) {
      out.push({
        unitId: u.id,
        code: "no_face",
        source: "visual",
        message: "rosto não visível, sem take substituto",
      });
    } else if (u.ambiguous) {
      out.push({
        unitId: u.id,
        code: "looks_away",
        source: "visual",
        message: "faixa ambígua: possível olhar para o operador",
      });
    }
  }
  return out;
}
