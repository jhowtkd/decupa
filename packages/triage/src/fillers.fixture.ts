import { isFillerAligned, normalizeFillerText, opensWithFillerAnswer, type FillerToken } from "./fillers.ts";

type FixtureUnit = { id: string; text: string; is_question: boolean; words: FixtureWord[] };
type FixtureWord = { text: string; start: number; end: number; confidence?: number | null };

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Error(`fixture ritmo: ${field} não é número finito`);
  return value;
}

/** Só testes: o ritmo não guarda confidence. Simular alinhamento prova as
 * regras textuais, nunca a qualidade dos tempos nem a emenda no áudio. */
export function ritmoFillerTokens(raw: unknown, opts: { simulateAlignment: boolean }): FillerToken[] {
  const units = (raw as { units?: FixtureUnit[] })?.units;
  if (!Array.isArray(units)) throw Error("fixture ritmo sem units");
  const tokens: FillerToken[] = [];
  for (const [ui, unit] of units.entries()) {
    if (!Array.isArray(unit.words) || typeof unit.text !== "string") throw Error("fixture ritmo sem palavras/texto");
    const parts = [...unit.text.matchAll(/\S+/g)];
    if (parts.length !== unit.words.length) throw Error(`fixture ritmo: palavras divergentes em ${unit.id}`);
    let cursor = 0;
    for (const [wi, word] of unit.words.entries()) {
      const part = parts[wi]!;
      const position = part.index;
      // u035 tem "fica..." no token e "fica." no texto da unidade.
      // Normalizar só essa comparação preserva a pontuação real do separador.
      if (normalizeFillerText(part[0]) !== normalizeFillerText(word.text)) throw Error(`fixture ritmo: palavra ${word.text} ausente em ${unit.id}`);
      const punctuation = wi > 0 ? parts[wi - 1]![0].match(/[\p{P}\p{S}]+$/u)?.[0] ?? "" : "";
      tokens.push({
        wordId: `ritmo:${unit.id}:w${wi}`, text: word.text,
        start: num(word.start, "start"), end: num(word.end, "end"),
        aligned: word.confidence === undefined && opts.simulateAlignment ? true : isFillerAligned(word.confidence),
        unitId: unit.id, unitEndsWithQuestion: unit.is_question,
        isLastInUnit: wi === unit.words.length - 1, unitWordCount: unit.words.length,
        nextUnitOpensWithAnswer: opensWithFillerAnswer(units[ui + 1]?.text ?? ""),
        separatorBefore: punctuation + unit.text.slice(cursor, position), prevEnd: null, nextStart: null,
      });
      cursor = position + part[0].length;
    }
  }
  return tokens.map((token, i) => ({ ...token, prevEnd: tokens[i - 1]?.end ?? null, nextStart: tokens[i + 1]?.start ?? null }));
}
