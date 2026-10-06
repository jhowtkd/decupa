export const FILLER_CATEGORIES = [
  "hesitation", "repetition", "tag_final", "unit_only_filler", "ambiguous",
] as const;
export type FillerCategory = (typeof FILLER_CATEGORIES)[number];
export type FillerFlow = "montagem" | "limpeza";

export type FillerToken = {
  wordId: string; text: string; start: number; end: number; aligned: boolean;
  unitId: string; unitEndsWithQuestion: boolean; isLastInUnit: boolean; unitWordCount: number;
  nextUnitOpensWithAnswer: boolean; separatorBefore: string;
  prevEnd: number | null; nextStart: number | null;
};

export type FillerCandidate = {
  id: string; category: FillerCategory; token: string; wordIds: string[];
  start: number; end: number; rule: string;
  verdict: "cut" | "signal" | "abstain"; abstainReason?: string;
};

export const FILLERS_HARD_PT: ReadonlySet<string> = new Set(["ahn", "han", "hã", "hum", "humm", "hmm", "uhn"]);
export const FILLER_TAGS_PT: ReadonlySet<string> = new Set(["tá", "né"]);
export const FILLER_ANSWERS_PT: ReadonlySet<string> = new Set(["sim", "isso mesmo", "claro", "com certeza", "exatamente"]);
export const FILLERS_AMBIGUOUS_PT: ReadonlySet<string> = new Set(["é", "tá", "sim", "então", "né"]);
export const FILLERS_UNIT_ONLY_PT: ReadonlySet<string> = new Set([
  ...FILLERS_HARD_PT, ...FILLER_TAGS_PT, "entende", "entendeu", "sabe", "certo",
  "tipo assim", "sabe como é", "você sabe",
]);

export const FILLER_AUTO_CATEGORIES: Readonly<Record<FillerFlow, ReadonlySet<FillerCategory>>> = {
  montagem: new Set(["hesitation"]),
  limpeza: new Set(["hesitation", "repetition"]),
};

export const FILLER_MIN_GAP_SECONDS: Readonly<Record<FillerFlow, number>> = {
  montagem: 0.05,
  limpeza: 0.02,
};

export const FILLER_MECHANIC_VERSION: Readonly<Record<FillerFlow, string>> = {
  // T2 incrementa esta versão sempre que mudar snap, clamp ou merge dos cortes.
  montagem: "montagem:1",
  // Seleção lexical atual do motor. T3 substitui pelo hash do trecho
  // drop_filler_spans do local-engine.patch, com teste de vínculo ao trecho.
  limpeza: "limpeza:lexical-hard+stutter@b17559e",
};

export function normalizeFillerText(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("pt-BR").trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

/** Zero em caches antigos também representa palavra sem score do alinhador. */
export function isFillerAligned(confidence: number | null | undefined): boolean {
  return typeof confidence === "number" && Number.isFinite(confidence) && confidence > 0;
}

export function opensWithFillerAnswer(text: string): boolean {
  const normalized = text.split(/\s+/).map(normalizeFillerText).join(" ");
  return [...FILLER_ANSWERS_PT].some(answer => normalized === answer || normalized.startsWith(`${answer} `));
}

function num(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Error(`cacoetes: ${field} não é número finito`);
  return value;
}

function hasGap(later: number, earlier: number, minimum: number): boolean {
  // 182,545 − 182,525 pode virar 0,01999999999998. A tolerância só cobre
  // arredondamento IEEE, sem aceitar uma folga perceptivelmente menor.
  const roundoff = 2 * Number.EPSILON * Math.max(1, Math.abs(later), Math.abs(earlier));
  return later - earlier + roundoff >= minimum;
}

function abstention(words: FillerToken[], category: FillerCategory, minGapSeconds: number): string | undefined {
  if (words.some(word => !word.aligned)) return "tempo estimado sem alinhamento";
  if (words.some(word => word.start < 0 || word.end <= word.start)) return "intervalo de palavra inválido";
  const first = words[0]!, last = words.at(-1)!;
  // Só as fronteiras externas do grupo importam: todas as ocorrências
  // anteriores da repetição saem juntas, e a última fica fora do grupo.
  if ((first.prevEnd !== null && !hasGap(first.start, first.prevEnd, minGapSeconds))
    || (last.nextStart !== null && !hasGap(last.nextStart, last.end, minGapSeconds))) return "fronteira sem corredor livre";
  if (words.some((word, i) => i > 0 && word.start < words[i - 1]!.end)) return "palavras sobrepostas";
  if (category === "tag_final" && last.nextUnitOpensWithAnswer) return "pergunta seguida de resposta";
  return undefined;
}

export function classifyFillers(tokens: FillerToken[], auto: ReadonlySet<FillerCategory>, minGapSeconds: number): FillerCandidate[] {
  num(minGapSeconds, "minGapSeconds");
  if (minGapSeconds < 0) throw Error("cacoetes: minGapSeconds não pode ser negativo");
  const ids = new Set<string>();
  for (const word of tokens) {
    if (!word.wordId || ids.has(word.wordId)) throw Error(`cacoetes: wordId ausente ou duplicado ${word.wordId}`);
    ids.add(word.wordId);
    num(word.start, "start"); num(word.end, "end"); num(word.unitWordCount, "unitWordCount");
    if (word.prevEnd !== null) num(word.prevEnd, "prevEnd");
    if (word.nextStart !== null) num(word.nextStart, "nextStart");
  }
  const candidates: FillerCandidate[] = [], consumed = new Set<string>();
  const emit = (words: FillerToken[], category: FillerCategory, rule: string): void => {
    words.forEach(word => consumed.add(word.wordId));
    const abstainReason = abstention(words, category, minGapSeconds);
    candidates.push({
      id: `${category}:${words[0]!.wordId}`, category,
      token: normalizeFillerText(words[0]!.text), wordIds: words.map(word => word.wordId),
      start: words[0]!.start, end: words.at(-1)!.end, rule,
      verdict: abstainReason ? "abstain" : auto.has(category) ? "cut" : "signal",
      ...(abstainReason ? { abstainReason } : {}),
    });
  };
  const units = new Map<string, FillerToken[]>();
  for (const word of tokens) {
    const unit = units.get(word.unitId) ?? [];
    unit.push(word); units.set(word.unitId, unit);
  }
  for (const unit of units.values()) {
    const text = unit.map(word => normalizeFillerText(word.text)).join(" ");
    // Um recorte parcial de unidade nunca basta para declará-la só cacoete.
    if (unit.length === unit[0]!.unitWordCount && (FILLERS_UNIT_ONLY_PT.has(text)
      || unit.every(word => FILLERS_UNIT_ONLY_PT.has(normalizeFillerText(word.text))))) {
      emit(unit, "unit_only_filler", "unidade inteira feita de cacoete");
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i]!;
    if (consumed.has(first.wordId)) continue;
    const text = normalizeFillerText(first.text);
    // Partícula pura não tem ocorrência a manter: cada hesitação continua
    // sendo sua própria candidata, inclusive quando se repete na frase.
    if (FILLERS_HARD_PT.has(text)) {
      emit([first], "hesitation", "partícula pura de hesitação");
      continue;
    }
    let end = i;
    while (text && end + 1 < tokens.length) {
      const prev = tokens[end]!, next = tokens[end + 1]!;
      if (next.unitId !== first.unitId || consumed.has(next.wordId) || normalizeFillerText(next.text) !== text
        || !/^\s+$/u.test(next.separatorBefore) || /[\p{P}\p{S}]$/u.test(prev.text.trim())) break;
      end++;
    }
    if (end > i) {
      emit(tokens.slice(i, end), "repetition", "repetição consecutiva só com espaço; manter a última");
      // A última fica preservada pela regra de repetição. Somente palavras
      // que aparecem no candidato entram em consumed; hesitações vêm antes.
      i = end;
      continue;
    }
    if (FILLER_TAGS_PT.has(text) && first.isLastInUnit && first.unitWordCount > 1 && first.unitEndsWithQuestion) {
      emit([first], "tag_final", "tag na última palavra de unidade interrogativa");
    } else if (FILLERS_AMBIGUOUS_PT.has(text) && (text !== "então" || tokens[i - 1]?.unitId !== first.unitId)
      && (text !== "né" || !first.isLastInUnit)) {
      emit([first], "ambiguous", "palavra dependente do contexto");
    }
  }
  return candidates.sort((a, b) => a.start - b.start
    || (a.wordIds[0]! < b.wordIds[0]! ? -1 : a.wordIds[0]! > b.wordIds[0]! ? 1 : 0));
}
