/**
 * Correlação cruzada normalizada de média zero entre duas fatias de mesmo
 * tamanho. Devolve -1..1, ou 0 quando um dos lados não tem variação.
 */
export function ncc(
  a: Int16Array,
  aOffset: number,
  b: Int16Array,
  bOffset: number,
  length: number,
): number {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < length; i++) {
    sumA += a[aOffset + i]!;
    sumB += b[bOffset + i]!;
  }
  const meanA = sumA / length;
  const meanB = sumB / length;

  let numerator = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[aOffset + i]! - meanA;
    const y = b[bOffset + i]! - meanB;
    numerator += x * y;
    varA += x * x;
    varB += y * y;
  }

  const denominator = Math.sqrt(varA * varB);
  return denominator === 0 ? 0 : numerator / denominator;
}
