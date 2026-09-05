/**
 * Léxico PT-BR de fala com operador/editor — a pessoa não está falando
 * com quem assiste.
 *
 * Case-insensitive. `foi?` só casa como enunciado quase inteiro, para não
 * pegar "foi" no meio de conteúdo.
 */

const DIRECTOR_CUE_PATTERNS: RegExp[] = [
  /\bcorta\s+(essa|aí|isso)\b/i,
  /\bvou\s+(repetir|falar\s+de\s+novo|começar\s+de\s+novo)\b/i,
  /\bdeixa\s+eu\b/i,
  /\bde\s+novo\b/i,
  /\bperaí?\b/i,
  /\bcalma\s+aí\b/i,
  /\btá\s+gravando\b/i,
  /\bficou\s+bom\b/i,
  /\besqueci\b/i,
  /\b(perdão|desculpa)\b/i,
  /\bagora\s+vai\b/i,
  // "Ih, foi!" / "foi?" como fala quase inteira — não "foi" no meio da frase.
  /^\s*(ih[,!]?\s*)?foi\s*[?!]?\s*$/i,
];

export function hasDirectorCue(text: string): boolean {
  return DIRECTOR_CUE_PATTERNS.some((re) => re.test(text));
}
