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
