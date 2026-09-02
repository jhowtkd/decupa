import type { EnergyEnvelope } from "./envelope.ts";

export interface SnapResult {
  /** Posição final do corte, em ms. */
  ms: number;
  /** Deslocamento aplicado (positivo = empurrou para frente). */
  movedByMs: number;
}

/**
 * Empurra um corte para o quadro de menor energia dentro de ±windowMs.
 * Em empate, vence o quadro mais próximo do alvo — mover menos é sempre melhor.
 */
export function snapCut(opts: {
  envelope: EnergyEnvelope;
  targetMs: number;
  windowMs?: number;
}): SnapResult {
  const { envelope, targetMs } = opts;
  const windowMs = opts.windowMs ?? 120;
  const { hopMs, rms } = envelope;

  if (rms.length === 0) return { ms: targetMs, movedByMs: 0 };

  const targetFrame = Math.round(targetMs / hopMs);
  const radius = Math.round(windowMs / hopMs);
  const lo = Math.max(0, targetFrame - radius);
  const hi = Math.min(rms.length - 1, targetFrame + radius);

  let bestFrame = Math.min(Math.max(targetFrame, lo), hi);
  let bestEnergy = rms[bestFrame]!;
  let bestDistance = Math.abs(bestFrame - targetFrame);

  for (let frame = lo; frame <= hi; frame++) {
    const energy = rms[frame]!;
    const distance = Math.abs(frame - targetFrame);
    if (energy < bestEnergy || (energy === bestEnergy && distance < bestDistance)) {
      bestFrame = frame;
      bestEnergy = energy;
      bestDistance = distance;
    }
  }

  const ms = bestFrame * hopMs;
  return { ms, movedByMs: ms - targetMs };
}
