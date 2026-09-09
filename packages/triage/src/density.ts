import type { DensityCandidate } from "./model.ts";
import { unitsById, type SpeechIndex } from "./speech-index.ts";

export const DENSITY_INSTRUCTIONS = `A fala abaixo já teve o que não é conteúdo removido. Agora ela precisa encurtar, e o corte vai custar conteúdo de verdade.

Devolva candidatos a sair, do mais dispensável para o menos, cada um com "rank" (1 sai primeiro). Prefira nesta ordem:

1. unidade que repete o que outra já disse melhor;
2. exemplo a mais numa enumeração que já se entende;
3. elaboração que não muda a conclusão.

Nunca proponha tirar: a frase de abertura, a conclusão, ou uma unidade que responde a uma pergunta que fica.

Só "unit_ids" — nunca tempo. Unidade inteira, nunca pedaço.`;

/**
 * Aplica candidatos por rank até fechar o orçamento.
 *
 * Ao contrário do passe 1, aqui não há verificação por máquina: "isto é
 * redundante com o argumento" não é checável contra o índice. O que existe é
 * o orçamento — sem alvo explícito, "corte o que é redundante" não tem
 * condição de parada. A checagem de verdade é a leitura do condense_script.md.
 */
export function applyDensityBudget(
  candidates: DensityCandidate[],
  index: SpeechIndex,
  opts: { budgetSeconds: number; alreadyDropped: Set<string> },
): {
  droppedIds: Set<string>;
  applied: DensityCandidate[];
  skipped: { candidate: DensityCandidate; why: string }[];
} {
  const droppedIds = new Set<string>();
  const applied: DensityCandidate[] = [];
  const skipped: { candidate: DensityCandidate; why: string }[] = [];
  let spent = 0;
  // Map pago uma vez: o passe varre candidatos × unidades, find por id seria O(n²)
  const byId = unitsById(index);

  const survivors = index.units.filter((u) => !opts.alreadyDropped.has(u.id)).length;

  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
    const units = candidate.unit_ids.map((id) => byId.get(id));
    const missing = candidate.unit_ids.filter((_, i) => units[i] === undefined);
    if (missing.length > 0) {
      skipped.push({ candidate, why: `unidade inexistente no índice: ${missing.join(", ")}` });
      continue;
    }
    if (candidate.unit_ids.some((id) => opts.alreadyDropped.has(id))) {
      skipped.push({ candidate, why: "já saiu no passe 1" });
      continue;
    }
    if (candidate.unit_ids.some((id) => droppedIds.has(id))) {
      skipped.push({ candidate, why: "já saiu em candidato anterior deste passe" });
      continue;
    }
    if (survivors - droppedIds.size - candidate.unit_ids.length < 1) {
      skipped.push({ candidate, why: "dropar isto não deixaria unidade nenhuma de pé" });
      continue;
    }

    const cost = units.reduce((n, u) => n + u!.duration, 0);
    if (spent + cost > opts.budgetSeconds) break;

    for (const id of candidate.unit_ids) droppedIds.add(id);
    applied.push(candidate);
    spent += cost;
  }

  return { droppedIds, applied, skipped };
}
