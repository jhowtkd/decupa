/**
 * Similaridade de texto para detectar retomada quase-verbatim.
 *
 * O `condense_index` do motor também mede isso, mas só expõe o número como
 * prosa em inglês dentro de `trim_candidates[].reasons`
 * ("restates u032 (similarity 1.0)"). Depender daquilo acoplaria a verificação
 * à redação do motor, então medimos por conta própria.
 *
 * Coeficiente de Dice sobre bigramas de token: mais discriminante que
 * sobreposição de palavras soltas, que casaria "não escala" em duas frases
 * sobre assuntos diferentes.
 */

/** Acima disto, duas unidades contam como a mesma frase repetida. */
export const RESTATEMENT_THRESHOLD = 0.8;

/** Unidade com até este tanto de tokens usa Jaccard de conjunto, não Dice de bigrama. */
export const SHORT_UNIT_TOKEN_LIMIT = 6;

/** Limiar SequenceMatcher do motor (`near_duplicate_of`). */
export const MOTOR_DUPLICATE_THRESHOLD = 0.74;

/**
 * Jaccard mínimo para unidade curta contar como retomada.
 *
 * 0.65 pega u026/u027 (5/7 ≈ 0.71) e u012/u013 (1.0). Fica acima de u009/u010
 * (0.4), que só tem headOverlap e o ouro mantém os dois.
 */
export const SHORT_JACCARD_THRESHOLD = 0.65;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function bigrams(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length - 1; i += 1) out.push(`${list[i]} ${list[i + 1]}`);
  return out;
}

/** Dice sobre multiconjuntos: 2·|A∩B| / (|A|+|B|). */
function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const item of a) pool.set(item, (pool.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const left = pool.get(item) ?? 0;
    if (left > 0) {
      shared += 1;
      pool.set(item, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  // Uma palavra só não produz bigrama; sem este desvio toda interjeição
  // ("Entende?", "Ih, foi!") mediria 0 contra qualquer coisa.
  if (ta.length < 2 || tb.length < 2) return dice(ta, tb);
  return dice(bigrams(ta), bigrams(tb));
}

/** Jaccard de conjuntos de token: |A∩B| / |A∪B|. */
export function shortUnitSimilarity(a: string, b: string): number {
  const aSet = new Set(tokens(a));
  const bSet = new Set(tokens(b));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let shared = 0;
  for (const t of aSet) if (bSet.has(t)) shared += 1;
  return shared / (aSet.size + bSet.size - shared);
}

/**
 * Tokens que preservam hífen, para casar "ex-aluno" como uma peça só.
 * A tokenização do Dice parte o hífen; aqui o trecho colado é o sinal.
 */
function overlapTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * A unidade seguinte começa com o fim da anterior — enumeração que reitera
 * o último item (u009/u010 "ex-aluno,", u012/u013 "entre outras").
 */
export function headOverlap(earlier: string, later: string): boolean {
  const a = overlapTokens(earlier);
  const b = overlapTokens(later);
  if (a.length === 0 || b.length === 0) return false;
  const max = Math.min(a.length, b.length);
  for (let k = max; k >= 1; k -= 1) {
    const suffix = a.slice(-k);
    if (suffix.every((t, i) => t === b[i])) {
      // Um token só só conta se for substancial ("ex-aluno"), senão "e"/"o" casam à toa.
      if (k >= 2 || suffix[0]!.length >= 4) return true;
    }
  }
  return false;
}

/**
 * Ratcliff-Obershelp (SequenceMatcher sem autojunk): 2·|matches| / (|A|+|B|).
 * Usado quando o índice não trouxe `similarity` do motor — o mesmo limiar 0.74.
 */
export function characterSimilarity(a: string, b: string): number {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa.length === 0 && bb.length === 0) return 1;
  if (aa.length === 0 || bb.length === 0) return 0;
  return (2 * matchingLength(aa, bb, 0, aa.length, 0, bb.length)) / (aa.length + bb.length);
}

function matchingLength(
  a: string,
  b: string,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): number {
  let bestI = a0;
  let bestJ = b0;
  let bestSize = 0;
  for (let i = a0; i < a1; i += 1) {
    for (let j = b0; j < b1; j += 1) {
      let k = 0;
      while (i + k < a1 && j + k < b1 && a[i + k] === b[j + k]) k += 1;
      if (k > bestSize) {
        bestI = i;
        bestJ = j;
        bestSize = k;
      }
    }
  }
  if (bestSize === 0) return 0;
  return bestSize
    + matchingLength(a, b, a0, bestI, b0, bestJ)
    + matchingLength(a, b, bestI + bestSize, a1, bestJ + bestSize, b1);
}

/**
 * Retomada se qualquer régua dispara: Dice de bigramas, Jaccard curto, ou
 * SequenceMatcher do motor (ou o equivalente local).
 *
 * headOverlap sozinho NÃO conta — u009/u010 casam a cabeça e o ouro mantém os dois.
 */
export function isRestatement(aText: string, bText: string, motorSimilarity?: number | null): boolean {
  if (similarity(aText, bText) >= RESTATEMENT_THRESHOLD) return true;
  const ta = tokens(aText);
  const tb = tokens(bText);
  if (
    (ta.length <= SHORT_UNIT_TOKEN_LIMIT || tb.length <= SHORT_UNIT_TOKEN_LIMIT)
    && shortUnitSimilarity(aText, bText) >= SHORT_JACCARD_THRESHOLD
  ) {
    return true;
  }
  if (motorSimilarity != null && motorSimilarity >= MOTOR_DUPLICATE_THRESHOLD) return true;
  return false;
}
