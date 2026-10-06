import {
  classifyFillers, FILLER_AUTO_CATEGORIES, FILLER_CATEGORIES, FILLER_MECHANIC_VERSION, FILLER_MIN_GAP_SECONDS,
  type FillerCategory, type FillerFlow, type FillerToken,
} from "./fillers.ts";

export const FILLER_NEGATIVE_CATEGORIES = [
  "e_hesitacao", "ta_verbo", "sim_resposta", "ha_pergunta", "hum_concordancia", "ne_pergunta_real", "enfase_repetida",
] as const;
export type FillerNegativeCategory = (typeof FILLER_NEGATIVE_CATEGORIES)[number];
export type FillerGoldCell = { flow: FillerFlow; category: FillerCategory };
export type FillerGoldItem = {
  id: string; split: "dev" | "eval"; cell: FillerGoldCell;
  tokens: FillerToken[]; targetWordIds: string[]; editorial: "cut" | "keep";
  audio: "unreviewed" | "ok" | "bad_join"; reachable: boolean; control: boolean;
  method: "implementation-reading" | "human-listening"; mechanicVersion: string | null;
  negativeCategory?: FillerNegativeCategory;
  source: { unitId: string; transcriptSha256: string; labelNote: string };
};
export type FillerGold = {
  version: 1;
  provenance: {
    corpus: string; sourceFile: string; sourceSha256: string; transcriptSha256: string;
    asrProfile: string | null; labelNote: string; timingNote: string;
  };
  items: FillerGoldItem[];
};

/** A origem declarada tem de sobreviver à leitura do JSON: leitura técnica
 * nunca pode virar escuta humana por um cast TypeScript. */
export function parseFillerGold(raw: unknown): FillerGold {
  const fail = (field: string): never => { throw Error(`gold de cacoetes: ${field} inválido`); };
  const obj = (value: unknown, field: string): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(field);
  const text = (value: unknown, field: string): string => typeof value === "string" && value.length > 0 ? value : fail(field);
  const num = (value: unknown, field: string): number => typeof value === "number" && Number.isFinite(value) ? value : fail(field);
  const bool = (value: unknown, field: string): boolean => typeof value === "boolean" ? value : fail(field);
  const root = obj(raw, "raiz"), provenance = obj(root.provenance, "provenance");
  if (root.version !== 1 || !Array.isArray(root.items)) fail("version/items");
  const ids = new Set<string>();
  const items = (root.items as unknown[]).map(value => {
    const item = obj(value, "item"), cell = obj(item.cell, "cell"), source = obj(item.source, "source");
    const id = text(item.id, "id");
    if (ids.has(id)) fail("id duplicado");
    ids.add(id);
    if (!["dev", "eval"].includes(item.split as string) || !["cut", "keep"].includes(item.editorial as string)
      || !["montagem", "limpeza"].includes(cell.flow as string) || !FILLER_CATEGORIES.includes(cell.category as FillerCategory)
      || (item.category !== undefined && item.category !== cell.category)
      || !["implementation-reading", "human-listening"].includes(item.method as string)
      || (item.split === "eval" && item.method !== "human-listening")
      || !["unreviewed", "ok", "bad_join"].includes(item.audio as string)
      || (item.method !== "human-listening" && item.audio !== "unreviewed")) fail(`rótulos ${id}`);
    if (item.audio !== "unreviewed" && (typeof item.mechanicVersion !== "string" || !item.mechanicVersion.trim())) {
      fail(`mechanicVersion ${id}`);
    }
    if (!Array.isArray(item.tokens) || !Array.isArray(item.targetWordIds) || item.targetWordIds.length === 0) fail(`palavras ${id}`);
    const tokens = (item.tokens as unknown[]).map(value => {
      const token = obj(value, "token");
      return {
        wordId: text(token.wordId, "wordId"), text: text(token.text, "text"),
        start: num(token.start, "start"), end: num(token.end, "end"), aligned: bool(token.aligned, "aligned"),
        unitId: text(token.unitId, "unitId"), unitEndsWithQuestion: bool(token.unitEndsWithQuestion, "unitEndsWithQuestion"),
        isLastInUnit: bool(token.isLastInUnit, "isLastInUnit"), unitWordCount: num(token.unitWordCount, "unitWordCount"),
        nextUnitOpensWithAnswer: bool(token.nextUnitOpensWithAnswer, "nextUnitOpensWithAnswer"),
        separatorBefore: typeof token.separatorBefore === "string" ? token.separatorBefore : fail("separatorBefore"),
        prevEnd: token.prevEnd === null ? null : num(token.prevEnd, "prevEnd"),
        nextStart: token.nextStart === null ? null : num(token.nextStart, "nextStart"),
      };
    });
    const targetWordIds = (item.targetWordIds as unknown[]).map(value => text(value, "targetWordId"));
    if (new Set(tokens.map(token => token.wordId)).size !== tokens.length
      || new Set(targetWordIds).size !== targetWordIds.length) fail(`IDs de palavras ${id}`);
    const reachable = bool(item.reachable, "reachable");
    if (reachable && targetWordIds.some(id => !tokens.some(token => token.wordId === id))) fail(`targetWordId ausente ${id}`);
    const negativeCategory = item.negativeCategory;
    if (negativeCategory !== undefined && !FILLER_NEGATIVE_CATEGORIES.includes(negativeCategory as FillerNegativeCategory)) fail("negativeCategory");
    return {
      id, split: item.split as FillerGoldItem["split"],
      cell: { flow: cell.flow as FillerFlow, category: cell.category as FillerCategory }, tokens, targetWordIds,
      editorial: item.editorial as FillerGoldItem["editorial"], audio: item.audio as FillerGoldItem["audio"], reachable,
      control: bool(item.control, "control"), method: item.method as FillerGoldItem["method"],
      mechanicVersion: item.mechanicVersion === null ? null : text(item.mechanicVersion, "mechanicVersion"),
      ...(negativeCategory === undefined ? {} : { negativeCategory: negativeCategory as FillerNegativeCategory }),
      source: { unitId: text(source.unitId, "unitId"), transcriptSha256: text(source.transcriptSha256, "transcriptSha256"), labelNote: text(source.labelNote, "labelNote") },
    };
  });
  return { version: 1, items, provenance: {
    corpus: text(provenance.corpus, "corpus"), sourceFile: text(provenance.sourceFile, "sourceFile"),
    sourceSha256: text(provenance.sourceSha256, "sourceSha256"), transcriptSha256: text(provenance.transcriptSha256, "transcriptSha256"),
    asrProfile: provenance.asrProfile === null ? null : text(provenance.asrProfile, "asrProfile"),
    labelNote: text(provenance.labelNote, "labelNote"), timingNote: text(provenance.timingNote, "timingNote"),
  } };
}
export type FillerGoldEvaluation = {
  item: FillerGoldItem; predictedWordIds: string[];
  incorrect_removal: number; omission: number; correct_removal: number; correct_keep: number;
  detected: boolean; abstained: boolean;
};
export type FillerGoldMetrics = {
  cell: FillerGoldCell; n: number; reachable: number; detected: number; abstentions: number;
  incorrect_removal: number; omission: number; correct_removal: number; correct_keep: number;
  // Inalcançáveis continuam no denominador: cobertura não é precisão.
  coverage: number; reachability: number;
};

/** Mede a célula como habilitada, para avaliar uma eventual liberação. O
 * portão só chama esta simulação com rótulos de escuta humana do eval. */
export function evaluateFillerGold(item: FillerGoldItem): FillerGoldEvaluation {
  const candidates = classifyFillers(item.tokens, new Set([item.cell.category]), FILLER_MIN_GAP_SECONDS[item.cell.flow]);
  const targets = new Set(item.targetWordIds);
  const predicted = new Set(candidates.filter(candidate => candidate.verdict === "cut").flatMap(candidate => candidate.wordIds));
  const expected = item.editorial === "cut" ? targets : new Set<string>();
  const kept = item.tokens.filter(token => !expected.has(token.wordId));
  return {
    item, predictedWordIds: [...predicted],
    incorrect_removal: [...predicted].filter(id => !expected.has(id)).length,
    omission: [...expected].filter(id => !predicted.has(id)).length,
    correct_removal: [...expected].filter(id => predicted.has(id)).length,
    correct_keep: kept.filter(token => !predicted.has(token.wordId)).length,
    detected: candidates.some(candidate => candidate.category === item.cell.category && candidate.wordIds.some(id => targets.has(id))),
    abstained: candidates.some(candidate => candidate.wordIds.some(id => targets.has(id)) && candidate.verdict === "abstain"),
  };
}

export function measureFillerGold(items: readonly FillerGoldItem[], split: "dev" | "eval"): FillerGoldMetrics[] {
  const rows: FillerGoldMetrics[] = [];
  for (const flow of ["montagem", "limpeza"] as const) {
    for (const category of FILLER_CATEGORIES) {
      const evaluations = items.filter(item => item.split === split && item.cell.flow === flow && item.cell.category === category).map(evaluateFillerGold);
      const sum = (field: "incorrect_removal" | "omission" | "correct_removal" | "correct_keep") => evaluations.reduce((n, evaluation) => n + evaluation[field], 0);
      const n = evaluations.length;
      const reachable = evaluations.filter(evaluation => evaluation.item.reachable).length;
      const detected = evaluations.filter(evaluation => evaluation.item.reachable && evaluation.detected).length;
      rows.push({ cell: { flow, category }, n, reachable, detected,
        abstentions: evaluations.filter(evaluation => evaluation.abstained).length,
        incorrect_removal: sum("incorrect_removal"), omission: sum("omission"),
        correct_removal: sum("correct_removal"), correct_keep: sum("correct_keep"),
        coverage: n ? detected / n : 0, reachability: n ? reachable / n : 0,
      });
    }
  }
  return rows;
}

export function isFillerCompatibilityCell(cell: FillerGoldCell): boolean {
  return cell.category === "hesitation" || (cell.flow === "limpeza" && cell.category === "repetition");
}

export type FillerGoldGate = { cell: FillerGoldCell; passed: boolean; reasons: string[]; heard: number };

/** O JSON exige a escuta humana registrada; nunca pretende avaliar o áudio. */
export function fillerGoldGate(
  items: readonly FillerGoldItem[], cell: FillerGoldCell,
  mechanicVersion: string = FILLER_MECHANIC_VERSION[cell.flow],
): FillerGoldGate {
  const sample = items.filter(item => item.split === "eval" && item.method === "human-listening"
    && item.cell.flow === cell.flow && item.cell.category === cell.category);
  const reasons: string[] = [];
  if (sample.some(item => evaluateFillerGold(item).incorrect_removal > 0)) reasons.push("incorrect_removal editorial, incluindo controles");
  if (sample.some(item => item.audio === "bad_join")) reasons.push("bad_join ouvido nesta célula");
  const heard = sample.filter(item => !item.control && item.reachable && item.editorial === "cut"
    && item.method === "human-listening" && item.audio === "ok" && item.mechanicVersion === mechanicVersion).length;
  if (!isFillerCompatibilityCell(cell)) {
    if (heard < 10 || sample.some(item => item.audio !== "unreviewed" && item.mechanicVersion !== mechanicVersion)) {
      reasons.push("rode o ensaio de novo para esta célula");
    }
  }
  return { cell, passed: reasons.length === 0, reasons, heard };
}

export function assertFillerGoldGate(
  items: readonly FillerGoldItem[],
  auto: Readonly<Record<FillerFlow, ReadonlySet<FillerCategory>>> = FILLER_AUTO_CATEGORIES,
  versions: Readonly<Record<FillerFlow, string>> = FILLER_MECHANIC_VERSION,
): void {
  const failures: string[] = [];
  for (const flow of ["montagem", "limpeza"] as const) {
    for (const category of auto[flow]) {
      const gate = fillerGoldGate(items, { flow, category }, versions[flow]);
      if (!gate.passed) failures.push(`${flow}/${category}: ${gate.reasons.join("; ")}`);
    }
  }
  if (failures.length) throw Error(failures.join("\n"));
}
