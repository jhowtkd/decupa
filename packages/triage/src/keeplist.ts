import type { SpeechIndex } from "./speech-index.ts";

/**
 * Unidades sobreviventes → o argumento `--keep` do `condense.py plan`.
 *
 * Faixas consecutivas viram `u005-u031`; unidade solta fica `u007`. Manter
 * unidades consecutivas juntas importa: consecutivas não produzem corte
 * nenhum, que é a junção mais natural que existe.
 */
export function keepListFrom(index: SpeechIndex, droppedIds: Set<string>): string {
  const kept = index.units.filter((u) => !droppedIds.has(u.id));
  if (kept.length === 0) {
    throw new Error("a triagem dropou nenhuma unidade sobrando — não há o que cortar");
  }

  const ranges: string[] = [];
  let runStart = kept[0]!;
  let previous = kept[0]!;

  for (const unit of kept.slice(1)) {
    if (unit.index !== previous.index + 1) {
      ranges.push(runStart.id === previous.id ? runStart.id : `${runStart.id}-${previous.id}`);
      runStart = unit;
    }
    previous = unit;
  }
  ranges.push(runStart.id === previous.id ? runStart.id : `${runStart.id}-${previous.id}`);

  return ranges.join(" ");
}
