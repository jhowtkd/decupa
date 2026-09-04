import { RESTATEMENT_THRESHOLD, similarity } from "./similarity.ts";
import { topicSpan, type IndexUnit, type SpeechIndex } from "./speech-index.ts";

/** Categoria fechada. O modelo escolhe uma; o código confere a escolha. */
export type DropReason = "preroll" | "postroll" | "aside" | "restart_block";

export interface StructureClaim {
  unit_ids: string[];
  reason: DropReason;
  /** Só para `restart_block`: a unidade posterior que diz a frase inteira. */
  restated_by: string | null;
  note: string;
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
 */
export function verifyClaims(claims: StructureClaim[], index: SpeechIndex): Verdict[] {
  const claimed = new Set<string>();
  for (const c of claims) for (const id of c.unit_ids) claimed.add(id);

  const span = topicSpan(index);
  const inTopicRun = new Set<string>();
  for (const run of index.topicRuns) for (const id of run.unitIds) inTopicRun.add(id);

  const firstIndex = index.units[0]!.index;
  const lastIndex = index.units[index.units.length - 1]!.index;

  return claims.map((claim) => {
    const failed = checkClaim(claim, {
      index, claimed, span, inTopicRun, firstIndex, lastIndex,
    });
    return failed === null
      ? { claim, accepted: true as const }
      : { claim, accepted: false as const, failed };
  });
}

interface Context {
  index: SpeechIndex;
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
    const unit = ctx.index.units.find((u) => u.id === id);
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
        if (ctx.inTopicRun.has(unit.id)) {
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
      const target = ctx.index.units.find((u) => u.id === claim.restated_by);
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
      return null;
    }
  }
}

export function acceptedDropIds(verdicts: Verdict[]): Set<string> {
  const ids = new Set<string>();
  for (const v of verdicts) {
    if (v.accepted) for (const id of v.claim.unit_ids) ids.add(id);
  }
  return ids;
}
