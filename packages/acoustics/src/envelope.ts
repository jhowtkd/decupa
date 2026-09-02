import { DEFAULT_SAMPLE_RATE } from "@decupa/media";

export interface EnergyEnvelope {
  /** Passo entre quadros, em ms. */
  hopMs: number;
  /** RMS por quadro, normalizado para 0..1 em escala de amplitude. */
  rms: Float32Array;
}

const INT16_MAX = 32_768;

/**
 * RMS por janela deslizante não sobreposta de `hopMs`.
 * Quadros incompletos no fim são descartados, para que
 * `rms.length * hopMs` nunca ultrapasse a duração real.
 */
export function energyEnvelope(
  pcm: Int16Array,
  opts: { sampleRate?: number; hopMs?: number } = {},
): EnergyEnvelope {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const hopMs = opts.hopMs ?? 10;
  const hop = Math.round((hopMs * sampleRate) / 1000);
  const frameCount = Math.floor(pcm.length / hop);
  const rms = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    let sumSquares = 0;
    for (let i = start; i < start + hop; i++) {
      const sample = pcm[i]! / INT16_MAX;
      sumSquares += sample * sample;
    }
    rms[frame] = Math.sqrt(sumSquares / hop);
  }

  return { hopMs, rms };
}
