import { hasDirectorCue } from "./cues.ts";
import {
  MOTOR_DUPLICATE_THRESHOLD,
  RESTATEMENT_THRESHOLD,
  characterSimilarity,
  isRestatement,
  similarity,
} from "./similarity.ts";
import { looksLikeDeadAir, topicSpan, unitsById, type IndexUnit, type SpeechIndex } from "./speech-index.ts";

/** Categoria fechada. O modelo escolhe uma; o código confere a escolha. */
export type DropReason =
  | "preroll"
  | "postroll"
  | "aside"
  | "restart_block"
  | "retake"
  | "dead_air"
  | "director_cue";

export type ClaimSource = "mechanical" | "model" | "visual";

export interface StructureClaim {
  unit_ids: string[];
  reason: DropReason;
  /** Take que fica: obrigatório em `restart_block` e `retake`. */
  restated_by: string | null;
  note: string;
  source: ClaimSource;
}

export type Verdict =
  | { claim: StructureClaim; accepted: true }
  | { claim: StructureClaim; accepted: false; failed: string };

/**
 * Confere cada alegação contra o índice.
 *
 * O que isto faz: rejeita alegação impossível. O que isto NÃO faz: certificar
 * alegação correta. A regra de `preroll` aceita `u001-u005` tão bem quanto
 * `u001-u004` — ela prova que o trecho está antes do corpo, não que o gancho
 * do vídeo não foi junto. A leitura do `condense_script.md` continua sendo a
 * checagem de verdade.
 *
 * Ordem de avaliação: "unidade que fica" significa *não reivindicada por
 * nenhuma alegação deste passe* — conjunto calculado uma vez, antes de
 * qualquer rejeição. Sem isso, a ordem das alegações mudaria o resultado.
 *
 * `alreadyDropped` entra em `claimed` (passe mecânico, inspect). Sem isso o
 * modelo pode dropar o take que o mecânico deixou (u016 depois de u015).
 */
export function verifyClaims(
  claims: StructureClaim[],
  index: SpeechIndex,
  alreadyDropped: Iterable<string> = [],
): Verdict[] {
  if (index.units.length === 0) {
    return claims.map((claim) => ({
      claim,
      accepted: false as const,
      failed: "índice de fala não possui unidades",
    }));
  }

  const claimed = new Set<string>(alreadyDropped);
  for (const c of claims) for (const id of c.unit_ids) claimed.add(id);

  const span = topicSpan(index);
  const inTopicRun = new Set<string>();
  for (const run of index.topicRuns) for (const id of run.unitIds) inTopicRun.add(id);

  const firstIndex = index.units[0]!.index;
  const lastIndex = index.units[index.units.length - 1]!.index;

  return claims.map((claim) => {
    const failed = checkClaim(claim, {
      index, byId: unitsById(index), claimed, span, inTopicRun, firstIndex, lastIndex,
    });
    return failed === null
      ? { claim, accepted: true as const }
      : { claim, accepted: false as const, failed };
  });
}

interface Context {
  index: SpeechIndex;
  byId: Map<string, IndexUnit>;
  claimed: Set<string>;
  span: { first: number; last: number } | null;
  inTopicRun: Set<string>;
  firstIndex: number;
  lastIndex: number;
}

/** Devolve `null` se passa, ou a frase que descreve a condição que falhou. */
function checkClaim(claim: StructureClaim, ctx: Context): string | null {
  if (claim.unit_ids.length === 0) return "alegação sem unidade nenhuma";

  const units: IndexUnit[] = [];
  for (const id of claim.unit_ids) {
    const unit = ctx.byId.get(id);
    if (!unit) return `unidade ${id} não existe no índice`;
    units.push(unit);
  }
  units.sort((a, b) => a.index - b.index);

  const lo = units[0]!.index;
  const hi = units[units.length - 1]!.index;
  if (hi - lo + 1 !== units.length) return "as unidades não são contíguas";

  switch (claim.reason) {
    case "preroll": {
      if (lo !== ctx.firstIndex) return "pré-rolo não começa na primeira unidade do vídeo";
      if (ctx.span && hi >= ctx.span.first) {
        return "pré-rolo invade o corpo do vídeo (alcança unidade citada por topic_run)";
      }
      return null;
    }
    case "postroll": {
      if (hi !== ctx.lastIndex) return "pós-rolo não termina na última unidade do vídeo";
      if (ctx.span && lo <= ctx.span.last) {
        return "pós-rolo invade o corpo do vídeo (alcança unidade citada por topic_run)";
      }
      return null;
    }
    case "aside": {
      for (const unit of units) {
        if (ctx.inTopicRun.has(unit.id) && !hasDirectorCue(unit.text)) {
          return `${unit.id} pertence a um topic_run, então é assunto do vídeo, não aparte`;
        }
      }
      const keptBefore = ctx.index.units.some((u) => u.index < lo && !ctx.claimed.has(u.id));
      const keptAfter = ctx.index.units.some((u) => u.index > hi && !ctx.claimed.has(u.id));
      if (!keptBefore || !keptAfter) {
        return "aparte precisa de conteúdo mantido dos dois lados; na borda seria pré ou pós-rolo";
      }
      return null;
    }
    case "restart_block": {
      if (!claim.restated_by) return "restart_block sem `restated_by`";
      const target = ctx.byId.get(claim.restated_by);
      if (!target) return `unidade ${claim.restated_by} não existe no índice`;
      if (target.index <= hi) return "`restated_by` precisa ser posterior ao bloco";
      if (ctx.claimed.has(target.id)) {
        return "`restated_by` também está sendo dropada, então nada resta dizendo a frase";
      }
      const repeats = units.some((a, i) =>
        units.slice(i + 1).some((b) => similarity(a.text, b.text) >= RESTATEMENT_THRESHOLD),
      );
      if (!repeats) {
        return `nenhum par do bloco é quase-verbatim (limiar ${RESTATEMENT_THRESHOLD})`;
      }
      // Similaridade com restated_by é extra, não obrigatória: o caso de
      // aceitação u003–u005 vs u007 ("Isso não escala" / "Dessa forma, não
      // escala a comunicação.") não passa em isRestatement.
      return null;
    }
    case "retake": {
      if (!claim.restated_by) return "retake sem `restated_by`";
      const target = ctx.byId.get(claim.restated_by);
      if (!target) return `unidade ${claim.restated_by} não existe no índice`;
      if (units.some((u) => u.id === target.id)) {
        return "`restated_by` não pode estar no conjunto dropado";
      }
      if (ctx.claimed.has(target.id)) {
        return "`restated_by` também está sendo dropada, então nada resta dizendo a frase";
      }
      // Mecânico pode ficar com o take anterior (u020 vs u021–u023, ar morto depois).
      // Modelo e visual precisam do restated_by posterior, como restart_block.
      if (target.index <= hi && claim.source !== "mechanical") {
        return "`restated_by` precisa ser posterior ao bloco";
      }
      const droppedText = units.map((u) => u.text).join(" ");
      const motorSim = motorSimilarityBetween(units, target);
      if (!isRestatement(droppedText, target.text, motorSim)
        && characterSimilarity(droppedText, target.text) < MOTOR_DUPLICATE_THRESHOLD) {
        return "o bloco dropado não é retomada de `restated_by` (sem similaridade suficiente)";
      }
      return null;
    }
    case "dead_air": {
      if (units.length !== 1) return "ar morto cobre só uma unidade";
      const unit = units[0]!;
      const candidate = (ctx.index.trimCandidates ?? []).find((t) => t.id === unit.id);
      if (!candidate) return `${unit.id} não está em trim_candidates`;
      if (!looksLikeDeadAir(candidate.reasons)) {
        return `${unit.id} está em trim_candidates, mas as reasons não falam de ar morto`;
      }
      if (ctx.claimed.size >= ctx.index.units.length) {
        return "ar morto não pode ser o único conteúdo que resta";
      }
      return null;
    }
    case "director_cue": {
      for (const unit of units) {
        if (!hasDirectorCue(unit.text)) {
          return `${unit.id} não casa no léxico de fala com o operador`;
        }
      }
      return null;
    }
    default: {
      // Inalcançável pelo tipo, alcançável em runtime: provedor que só oferece
      // `json_object` (sem `json_schema`) não obriga o enum, e o modelo pode
      // inventar categoria. Sem este ramo a alegação era rejeitada com
      // `failed: undefined`, e o relatório imprimia "falhou: undefined".
      return `categoria de motivo desconhecida: \`${String(claim.reason)}\` — ` +
        "esperado preroll, postroll, aside, restart_block, retake, dead_air ou director_cue";
    }
  }
}

function motorSimilarityBetween(dropped: IndexUnit[], target: IndexUnit): number | null {
  let best: number | null = null;
  for (const unit of dropped) {
    const score = pairMotorScore(unit, target);
    if (score != null && (best == null || score > best)) best = score;
  }
  return best;
}

function pairMotorScore(a: IndexUnit, b: IndexUnit): number | null {
  if (a.nearDuplicateOf === b.id && a.similarity != null) return a.similarity;
  if (b.nearDuplicateOf === a.id && b.similarity != null) return b.similarity;
  return null;
}

export function acceptedDropIds(verdicts: Verdict[]): Set<string> {
  const ids = new Set<string>();
  for (const v of verdicts) {
    if (v.accepted) for (const id of v.claim.unit_ids) ids.add(id);
  }
  return ids;
}
