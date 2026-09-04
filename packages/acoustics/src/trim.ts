import type { Interval } from "@decupa/core";

/**
 * Onde o som de fato acaba dentro de um span alegado.
 *
 * O alinhamento forçado erra de um jeito específico e caro: quando um
 * segmento é seguido de silêncio longo, a última palavra do segmento é
 * esticada para cobrir a pausa inteira. Medido no material real: "né?"
 * alegando 11,15 s, "promessa." alegando 7,56 s. O motor de corte a jusante
 * fica cego para essas pausas — não são lacuna entre unidades, então o
 * tightening não as toca, e o silêncio sobrevive dentro do clipe.
 *
 * A decisão de onde o som acaba vem de **intervalos de silêncio detectados**
 * (limiar em dB, com duração mínima), não de um limiar relativo ao pico do
 * próprio span. Isso foi tentado e falhou no material real: uma palavra fraca
 * (pico 0,022) tem seu limiar relativo tão baixo que respiração ambiente passa
 * por fala, e o trim desiste — deixando 10,6 s de silêncio dentro do corte.
 */
export function trimTrailingSilence(opts: {
  /** Silêncios detectados no arquivo inteiro, de `detectSilence`. */
  silences: Interval[];
  startMs: number;
  endMs: number;
  /** A palavra nunca encolhe abaixo disso — sobra sempre algum corpo. */
  minDurationMs?: number;
  /** Folga mantida depois do último som, para não decapitar a consoante. */
  tailMs?: number;
}): number {
  const { silences, startMs, endMs } = opts;
  const minDurationMs = opts.minDurationMs ?? 120;
  const tailMs = opts.tailMs ?? 60;

  if (endMs <= startMs || silences.length === 0) return endMs;

  // A palavra fica no COMEÇO do span — é o fim que o alinhador estica. Então
  // o primeiro silêncio que começa dentro do span já marca onde ela acabou.
  //
  // Exigir que esse silêncio alcançasse o fim do span foi tentado e falhou:
  // uma respiração no meio da pausa a parte em dois, e a condição passava a
  // casar só com o segundo pedaço, deixando 10,6 s intactos. Silêncio de
  // 150 ms dentro de uma "palavra" já significa que a palavra terminou antes.
  for (const silence of silences) {
    if (silence.startMs <= startMs) continue;
    if (silence.startMs >= endMs) break;

    const trimmed = silence.startMs + tailMs;
    const floor = startMs + minDurationMs;
    return Math.round(Math.min(endMs, Math.max(trimmed, floor)));
  }

  return endMs;
}
