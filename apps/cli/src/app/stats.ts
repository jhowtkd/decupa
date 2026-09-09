export interface StatsUnit {
  id: string;
  start: number;
  end: number;
}

export interface StatsDrop {
  unit_ids: string[];
  reason: string;
}

export interface EditorialStats {
  sourceSeconds: number;
  outputSeconds: number;
  removedSeconds: number;
  unitsTotal: number;
  unitsRemoved: number;
  byReason: { reason: string; units: number; seconds: number }[];
  summary: string;
}

function mmss(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * O que a triagem sugeriu cortar, somado. Descreve a sugestão — não o corte
 * final, que é a pessoa lendo a prosa quem faz. O resumo é uma linha porque a
 * tela é de leitura: número dá contexto, dashboard rouba o foco.
 */
export function editorialStats(units: StatsUnit[], drop: StatsDrop[]): EditorialStats {
  const dur = new Map(units.map((u) => [u.id, Math.max(0, u.end - u.start)] as const));
  const removedIds = new Set(drop.flatMap((d) => d.unit_ids));

  const byReason = new Map<string, { reason: string; units: number; seconds: number }>();
  for (const d of drop) {
    const cur = byReason.get(d.reason) ?? { reason: d.reason, units: 0, seconds: 0 };
    cur.units += d.unit_ids.length;
    cur.seconds += d.unit_ids.reduce((n, id) => n + (dur.get(id) ?? 0), 0);
    byReason.set(d.reason, cur);
  }
  const ranked = [...byReason.values()].sort((a, b) => b.seconds - a.seconds);

  const sourceSeconds = units.reduce((n, u) => n + (dur.get(u.id) ?? 0), 0);
  const removedSeconds = [...removedIds].reduce((n, id) => n + (dur.get(id) ?? 0), 0);
  const summary = `corta ${mmss(removedSeconds)} de ${mmss(sourceSeconds)} · ` +
    `${removedIds.size}/${units.length} unidades` +
    (ranked[0] ? ` · mais: ${ranked[0].reason} (${mmss(ranked[0].seconds)})` : "");

  return {
    sourceSeconds,
    outputSeconds: sourceSeconds - removedSeconds,
    removedSeconds,
    unitsTotal: units.length,
    unitsRemoved: removedIds.size,
    byReason: ranked,
    summary,
  };
}
