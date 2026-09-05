/**
 * Índice visual por unidade: o sidecar emite IDs, nunca timestamps de corte.
 *
 * Ruim se o sinal cobre ≥ 50% da unidade; ambíguo na faixa [25%, 50%).
 */

export type VisualFlagCode = "looks_away" | "hand_on_face" | "no_face";

export const LOOKS_AWAY_BAD = 0.5;
export const LOOKS_AWAY_AMBIGUOUS = 0.25;
export const HAND_ON_FACE_BAD = 0.5;
export const HAND_ON_FACE_AMBIGUOUS = 0.25;
export const NO_FACE_BAD = 0.5;
export const NO_FACE_AMBIGUOUS = 0.25;

export interface VisualSample {
  t: number;
  lookDown: boolean;
  lookSide: boolean;
  handOnFace: boolean;
  face: boolean;
}

export interface VisualUnitFlags {
  id: string;
  looksAway: boolean;
  handOnFace: boolean;
  noFace: boolean;
  /** Algum sinal na faixa [25%, 50%). Independente das flags ruins. */
  ambiguous: boolean;
  samples: VisualSample[];
}

function isBad(ratio: number, threshold: number): boolean {
  return ratio >= threshold;
}

function inAmbiguous(ratio: number, floor: number, bad: number): boolean {
  return ratio >= floor && ratio < bad;
}

export function parseVisualIndex(raw: unknown): VisualUnitFlags[] {
  const root = raw as Record<string, unknown>;
  const rawUnits = root?.units;
  if (!Array.isArray(rawUnits)) {
    throw new Error("visual_index.json sem `units` — rode o sidecar de visão");
  }

  return rawUnits.map((u: Record<string, unknown>) => {
    const lookDown = Number(u.look_down_ratio ?? 0);
    const lookSide = Number(u.look_side_ratio ?? 0);
    const hand = Number(u.hand_on_face_ratio ?? 0);
    const missing = Number(u.face_missing_ratio ?? 0);
    const samples: VisualSample[] = Array.isArray(u.samples)
      ? u.samples.map((s: Record<string, unknown>) => ({
          t: Number(s.t),
          lookDown: Boolean(s.look_down),
          lookSide: Boolean(s.look_side),
          handOnFace: Boolean(s.hand_on_face),
          face: Boolean(s.face),
        }))
      : [];

    return {
      id: String(u.id),
      looksAway: isBad(lookDown, LOOKS_AWAY_BAD) || isBad(lookSide, LOOKS_AWAY_BAD),
      handOnFace: isBad(hand, HAND_ON_FACE_BAD),
      noFace: isBad(missing, NO_FACE_BAD),
      ambiguous:
        inAmbiguous(lookDown, LOOKS_AWAY_AMBIGUOUS, LOOKS_AWAY_BAD)
        || inAmbiguous(lookSide, LOOKS_AWAY_AMBIGUOUS, LOOKS_AWAY_BAD)
        || inAmbiguous(hand, HAND_ON_FACE_AMBIGUOUS, HAND_ON_FACE_BAD)
        || inAmbiguous(missing, NO_FACE_AMBIGUOUS, NO_FACE_BAD),
      samples,
    };
  });
}

export function flagsFor(id: string, parsed: VisualUnitFlags[]): VisualUnitFlags | undefined {
  return parsed.find((u) => u.id === id);
}
