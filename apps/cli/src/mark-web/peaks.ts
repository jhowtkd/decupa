const INT16_MAX = 32_768;

export interface Peaks {
  bucketsPerSecond: number;
  /** Vale de cada balde, normalizado para -1..0. */
  min: Float32Array;
  /** Pico de cada balde, normalizado para 0..1. */
  max: Float32Array;
}

/**
 * Reduz o PCM a pares min/max por balde, que é o que a tela precisa para
 * desenhar a onda. Um balde por pixel de largura mantém o desenho barato e
 * preserva o ataque — a subida de energia que o olho procura.
 *
 * Baldes incompletos no fim são descartados para que
 * `min.length / bucketsPerSecond` nunca ultrapasse a duração real.
 */
export function computePeaks(
  pcm: Int16Array,
  opts: { sampleRate: number; bucketsPerSecond: number },
): Peaks {
  const { sampleRate, bucketsPerSecond } = opts;
  const bucketSize = Math.max(1, Math.round(sampleRate / bucketsPerSecond));
  const bucketCount = Math.floor(pcm.length / bucketSize);

  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * bucketSize;
    let lo = 0;
    let hi = 0;
    for (let i = start; i < start + bucketSize; i++) {
      const sample = pcm[i]!;
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }
    min[bucket] = lo / INT16_MAX;
    max[bucket] = hi / INT16_MAX;
  }

  return { bucketsPerSecond, min, max };
}
